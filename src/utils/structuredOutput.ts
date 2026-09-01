import { z } from "zod";
import { BaseMessage, SystemMessage } from "@langchain/core/messages";
import { logger } from "./logger.js";

export interface InvokeStructuredOptions {
  name: string;
  metadata?: Record<string, any>;
  /**
   * Mapeamento declarativo de aliases de chave por campo do schema.
   * Usado pelo normalizador pré-parse para remapear chaves alternativas
   * que o LLM pode gerar quando o fallback é acionado.
   *
   * Exemplo:
   * ```ts
   * fieldAliases: { consolidatedMarkdown: ["snapshot", "markdown", "content"] }
   * ```
   */
  fieldAliases?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Utilidade: extração e sanitização de JSON bruto
// ---------------------------------------------------------------------------

export function extractAndParseJson(rawText: string): any {
  if (!rawText || typeof rawText !== "string") return null;

  // Limpa marcações markdown ```json e ``` se presentes
  const cleaned = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");

  // Determinar se o JSON principal é um objeto {} ou um array []
  let jsonSubstring: string | null = null;

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket && firstBracket < firstBrace && lastBracket > lastBrace) {
      jsonSubstring = cleaned.substring(firstBracket, lastBracket + 1);
    } else {
      jsonSubstring = cleaned.substring(firstBrace, lastBrace + 1);
    }
  } else if (firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket) {
    jsonSubstring = cleaned.substring(firstBracket, lastBracket + 1);
  }

  if (jsonSubstring) {
    // Corrige erros comuns de sintaxe JSON gerados por LLMs:
    jsonSubstring = jsonSubstring
      .replace(/:\s*,/g, ": null,")
      .replace(/:\s*}/g, ": null}")
      .replace(/,\s*}/g, "}")
      .replace(/,\s*\]/g, "]");

    try {
      return JSON.parse(jsonSubstring);
    } catch (parseErr) {
      // Sanitize raw unescaped newlines/tabs within quotes
      const sanitized = jsonSubstring.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match: string) => {
        return match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
      });
      try {
        return JSON.parse(sanitized);
      } catch {
        return null;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers internos de introspecção de schema Zod
// ---------------------------------------------------------------------------

function unwrapZod(schema: z.ZodType): z.ZodType {
  let inner: z.ZodType = schema;
  // Zod v4: wrappers use _def.innerType (Nullable, Optional, Default) or _def.in (ZodPipe from .transform())
  while (inner && (inner instanceof z.ZodNullable || inner instanceof z.ZodOptional || inner instanceof z.ZodDefault)) {
    inner = (inner as any)._def.innerType ?? (inner as any)._def.schema;
  }
  // Handle ZodPipe (.transform() in Zod v4) via duck-typing
  if (inner && (inner as any)._def?.in) {
    inner = (inner as any)._def.in;
    // May still be wrapped
    while (inner && (inner instanceof z.ZodNullable || inner instanceof z.ZodOptional || inner instanceof z.ZodDefault)) {
      inner = (inner as any)._def.innerType ?? (inner as any)._def.schema;
    }
  }
  return inner;
}

function getZodObjectShape(schema: z.ZodType): Record<string, z.ZodType> | null {
  const inner = unwrapZod(schema);
  if (inner instanceof z.ZodObject) return inner.shape as Record<string, z.ZodType>;
  return null;
}

function isZodStringField(schema: z.ZodType): boolean {
  return unwrapZod(schema) instanceof z.ZodString;
}

// ---------------------------------------------------------------------------
// Gerador de assinatura de schema para o prompt de fallback informado
// ---------------------------------------------------------------------------

/**
 * Introspecciona um ZodType e devolve uma string legível com os campos,
 * tipos e descrições esperados. Alimenta o fallback prompt com informações
 * concretas ao invés de um pedido genérico de "JSON válido".
 */
function generateSchemaSignature(schema: z.ZodType, indent = 0): string {
  const pad = "  ".repeat(indent);
  const inner = unwrapZod(schema);

  // Guard against unwrap returning undefined/null in edge cases
  if (!inner) return "any";

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodType>;
    const lines: string[] = ["{"];
    for (const [key, value] of Object.entries(shape)) {
      const typeLine = generateSchemaSignature(value, indent + 1);
      const desc = (value as any)._def?.description ?? (value as any)._def?.innerType?._def?.description ?? "";
      lines.push(`${pad}  "${key}": ${typeLine}${desc ? ` // ${desc}` : ""}`);
    }
    lines.push(`${pad}}`);
    return lines.join("\n");
  }

  if (inner instanceof z.ZodArray) {
    const itemType = generateSchemaSignature((inner as any)._def.type, indent);
    return `${itemType}[]`;
  }

  if (inner instanceof z.ZodEnum) {
    // Zod v4: _def.entries is an object map { A: "A", B: "B" }
    // Zod v3: _def.values is an array ["A", "B"]
    const entriesOrValues = (inner as any)._def.entries ?? (inner as any)._def.values;
    const values: string[] = Array.isArray(entriesOrValues)
      ? entriesOrValues
      : Object.values(entriesOrValues ?? {});
    return values.map((v: string) => `"${v}"`).join(" | ");
  }

  if (inner instanceof z.ZodString) return "string";
  if (inner instanceof z.ZodNumber) return "number";
  if (inner instanceof z.ZodBoolean) return "boolean";
  if (inner instanceof z.ZodRecord) return "Record<string, any>";

  return "any";
}

/**
 * Gera o prompt de fallback com a assinatura estruturada exata do schema.
 */
function buildFallbackPrompt(schema: z.ZodType, name: string): string {
  const signature = generateSchemaSignature(schema);
  return (
    `REGRA CRÍTICA DE FORMATO: Responda ESTRITAMENTE com um objeto JSON válido no formato abaixo.\n` +
    `NÃO inclua nenhuma explicação, texto introdutório ou blocos de código markdown.\n` +
    `O objeto JSON deve corresponder EXATAMENTE ao schema "${name}":\n\n` +
    `${signature}\n\n` +
    `Responda APENAS com o JSON, sem qualquer texto antes ou depois.`
  );
}

// ---------------------------------------------------------------------------
// Normalizador semântico pré-parse (Layer 4)
// ---------------------------------------------------------------------------

/**
 * Converte um objeto para string Markdown estruturada.
 * Usada quando o LLM retorna um objeto hierárquico mas o schema espera string.
 */
function objectToMarkdown(obj: Record<string, unknown>, depth = 0): string {
  return Object.entries(obj)
    .map(([k, v]) => {
      const title = k.replace(/_/g, " ").toUpperCase();
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return `${"#".repeat(depth + 2)} ${title}\n${objectToMarkdown(v as Record<string, unknown>, depth + 1)}`;
      }
      if (Array.isArray(v)) {
        return `${"#".repeat(depth + 2)} ${title}\n${(v as unknown[]).map(item => `- ${typeof item === "object" ? JSON.stringify(item) : item}`).join("\n")}`;
      }
      return `**${k}**: ${v}`;
    })
    .join("\n\n");
}

/**
 * Normaliza o payload bruto do LLM antes de passar para o Zod.parse():
 * 1. Aplica fieldAliases declarativos (remapeia chaves alternativas)
 * 2. Converte object→string quando o schema espera string (markdown fallback)
 * 3. Normaliza scalar→[scalar] quando o schema espera array
 */
function normalizePayload(
  parsed: Record<string, unknown>,
  schema: z.ZodType,
  fieldAliases: Record<string, string[]> = {}
): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  const shape = getZodObjectShape(schema);
  if (!shape) return parsed;

  const result: Record<string, unknown> = { ...parsed };

  for (const [fieldName, fieldSchema] of Object.entries(shape)) {
    // Step 1: Apply fieldAliases — if the primary key is missing, try aliases
    if (result[fieldName] === undefined || result[fieldName] === null) {
      const aliases = fieldAliases[fieldName] ?? [];
      for (const alias of aliases) {
        if (result[alias] !== undefined && result[alias] !== null) {
          result[fieldName] = result[alias];
          break;
        }
      }
    }

    const value = result[fieldName];
    const fieldInner = unwrapZod(fieldSchema);

    // Step 2: object → Markdown string when schema expects string
    if (
      fieldInner instanceof z.ZodString &&
      value !== null &&
      value !== undefined &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      result[fieldName] = objectToMarkdown(value as Record<string, unknown>);
    }

    // Step 3: scalar → array when schema expects array
    if (
      fieldInner instanceof z.ZodArray &&
      value !== null &&
      value !== undefined &&
      !Array.isArray(value)
    ) {
      result[fieldName] = [value];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Função principal: invokeStructuredWithFallback
// ---------------------------------------------------------------------------

/**
 * Executa uma chamada de modelo exigindo saída estruturada segundo um schema Zod.
 *
 * Fluxo de resiliência em 4 camadas:
 * 1. Invocação nativa com .withStructuredOutput()
 * 2. Recuperação direta de argumentos válidos contidos no erro (sem re-invocar LLM)
 * 3. Re-invocação com fallback prompt informado (com assinatura exata do schema)
 * 4. Normalizador semântico pré-parse (aliases, object→markdown, scalar→array)
 *
 * IMPORTANTE: NÃO usar `strict: true`. A DeepSeek rejeita com HTTP 400
 * quando o schema tem campos nullable. Use sempre .nullable().default(null)
 * ao invés de .optional() nos schemas Zod — isso resolve na raiz sem precisar
 * de `strict: false` explícito.
 *
 * Para remapear chaves alternativas que o LLM pode gerar, use `fieldAliases`:
 * ```ts
 * invokeStructuredWithFallback(model, schema, messages, {
 *   name: "MemoryConsolidatorSleep",
 *   fieldAliases: { consolidatedMarkdown: ["snapshot", "markdown", "content"] }
 * });
 * ```
 */
export async function invokeStructuredWithFallback<T>(
  model: any,
  schema: z.ZodType<T>,
  messages: BaseMessage[],
  options: InvokeStructuredOptions
): Promise<T> {
  const { name, metadata, fieldAliases = {} } = options;
  const structuredModel = model.withStructuredOutput(schema, { name });

  try {
    const result = await structuredModel.invoke(messages, { metadata });
    // Garante que os defaults do Zod sejam sempre aplicados mesmo se o parser nativo omitir chaves
    if (result && typeof result === "object") {
      try {
        return schema.parse(result);
      } catch {
        return result as T;
      }
    }
    return result as T;
  } catch (firstError: any) {
    // Camada 2: Tentar reparar diretamente os argumentos contidos no erro da primeira tentativa
    const errorCandidates: any[] = [
      firstError?.message,
      firstError?.args,
      firstError?.tool_call?.function?.arguments,
      firstError?.raw,
      firstError?.output,
      firstError?.llmOutput
    ];

    for (const candidate of errorCandidates) {
      if (!candidate) continue;
      try {
        let candidateObj: any = null;
        if (typeof candidate === "object") {
          candidateObj = candidate;
        } else if (typeof candidate === "string") {
          candidateObj = extractAndParseJson(candidate);
        }

        if (candidateObj && typeof candidateObj === "object") {
          const normalized = normalizePayload(candidateObj as Record<string, unknown>, schema, fieldAliases);
          const validated = schema.parse(normalized);
          logger.info(`[STRUCTURED_OUTPUT] Recuperado com sucesso diretamente do payload de erro de '${name}' via sanitização e validação Zod.`);
          return validated;
        }
      } catch {
        // Tenta próximo candidato
      }
    }

    logger.info(`[STRUCTURED_OUTPUT] Parser nativo falhou em '${name}'. Aplicando fallback com schema signature...`, { error: firstError?.message });

    // Camada 3: Re-invocação com fallback prompt informado (schema signature)
    try {
      const fallbackPromptText = buildFallbackPrompt(schema, name);
      const fallbackPrompt = new SystemMessage(fallbackPromptText);

      const rawResponse = await model.invoke([...messages, fallbackPrompt], { metadata });

      const rawText = typeof rawResponse.content === "string"
        ? rawResponse.content
        : JSON.stringify(rawResponse.content);

      let parsed = extractAndParseJson(rawText);

      // Fallback de último recurso: se a resposta é texto puro Markdown sem JSON
      // e o schema tem apenas 1 campo string principal, mapeia automaticamente
      if (!parsed && rawText && rawText.trim().length > 10) {
        const shape = getZodObjectShape(schema);
        const stringFields = shape ? Object.entries(shape).filter(([, v]) => isZodStringField(v)) : [];
        if (stringFields.length === 1) {
          parsed = { [stringFields[0][0]]: rawText.trim() };
          logger.info(`[STRUCTURED_OUTPUT] Resposta de texto puro mapeada para campo '${stringFields[0][0]}' do schema '${name}'.`);
        }
      }

      if (parsed && typeof parsed === "object") {
        // Camada 4: Normalizador semântico pré-parse
        const normalized = normalizePayload(parsed as Record<string, unknown>, schema, fieldAliases);
        const validated = schema.parse(normalized);
        return validated;
      }

      throw new Error(`Nenhum objeto JSON válido encontrado na resposta bruta: "${rawText.substring(0, 100)}..."`);
    } catch (fallbackError: any) {
      logger.error(`[STRUCTURED_OUTPUT] Fallback também falhou em '${name}':`, fallbackError);
      throw fallbackError;
    }
  }
}

