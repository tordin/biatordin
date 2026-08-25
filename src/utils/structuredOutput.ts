import { z } from "zod";
import { BaseMessage, SystemMessage } from "@langchain/core/messages";
import { logger } from "./logger.js";

interface InvokeStructuredOptions {
  name: string;
  metadata?: Record<string, any>;
}

function extractAndParseJson(rawText: string): any {
  // Limpa marcações markdown ```json e ``` se presentes
  const cleaned = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    let jsonSubstring = cleaned.substring(firstBrace, lastBrace + 1);

    // Corrige erros comuns de sintaxe JSON gerados por LLMs:
    // 1. Chaves com valor vazio antes de vírgula ou fecha-chave (ex: "response": , -> "response": null,)
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
      return JSON.parse(sanitized);
    }
  }

  return null;
}

/**
 * Executa uma chamada de modelo exigindo saída estruturada segundo um schema Zod.
 * Caso o parser nativo do LangChain falhe (ex: devido a invólucros markdown do DeepSeek ou sintaxe corrompida),
 * aplica automaticamente um fallback resiliente de extração via Regex e JSON.parse.
 */
export async function invokeStructuredWithFallback<T>(
  model: any,
  schema: z.ZodType<T>,
  messages: BaseMessage[],
  options: InvokeStructuredOptions
): Promise<T> {
  // IMPORTANTE: NÃO usar `strict: true` aqui. A DeepSeek rejeita com 400
  // ("Required properties must match all properties in the object") quando o
  // schema tem campos opcionais (.optional()/.nullish()) porque o zod-to-json-schema
  // com target openAi os serializa como OpenAiAnyType, incompatível com strict.
  const structuredModel = model.withStructuredOutput(schema, { name: options.name });

  try {
    const result = await structuredModel.invoke(messages, {
      metadata: options.metadata
    });
    return result as T;
  } catch (firstError: any) {
    // 1. Tentar reparar diretamente os argumentos da chamada de ferramenta contidos no erro da primeira tentativa
    if (firstError?.message) {
      try {
        const repaired = extractAndParseJson(firstError.message);
        if (repaired) {
          const validated = schema.parse(repaired);
          logger.info(`[STRUCTURED_OUTPUT] Recuperado com sucesso diretamente do payload de '${options.name}' via sanitização JSON.`);
          return validated;
        }
      } catch {
        // Se falhar o parse direto do erro, prossegue para o fallback com nova chamada ao LLM
      }
    }

    logger.info(`[STRUCTURED_OUTPUT] Parser nativo de saída estruturada falhou em '${options.name}'. Aplicando fallback regex...`, { error: firstError?.message });

    try {
      const fallbackPrompt = new SystemMessage(
        "REGRA CRÍTICA DE FORMATO: Responda ESTRITAMENTE em formato JSON válido. NÃO inclua nenhuma explicação, introdução ou blocos de código fora do JSON."
      );

      const rawResponse = await model.invoke([...messages, fallbackPrompt], {
        metadata: options.metadata
      });

      const rawText = typeof rawResponse.content === "string"
        ? rawResponse.content
        : JSON.stringify(rawResponse.content);

      const parsed = extractAndParseJson(rawText);
      if (parsed) {
        const validated = schema.parse(parsed);
        return validated;
      }

      throw new Error(`Nenhum objeto JSON válido encontrado na resposta bruta: "${rawText.substring(0, 100)}..."`);
    } catch (fallbackError: any) {
      logger.error(`[STRUCTURED_OUTPUT] Fallback de extração JSON também falhou em '${options.name}':`, fallbackError);
      throw fallbackError;
    }
  }
}
