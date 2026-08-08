import { z } from "zod";
import { BaseMessage, SystemMessage } from "@langchain/core/messages";
import { logger } from "./logger.js";

interface InvokeStructuredOptions {
  name: string;
  metadata?: Record<string, any>;
}

/**
 * Executa uma chamada de modelo exigindo saída estruturada segundo um schema Zod.
 * Caso o parser nativo do LangChain falhe (ex: devido a invólucros markdown do DeepSeek),
 * aplica automaticamente um fallback resiliente de extração via Regex e JSON.parse.
 */
export async function invokeStructuredWithFallback<T>(
  model: any,
  schema: z.ZodType<T>,
  messages: BaseMessage[],
  options: InvokeStructuredOptions
): Promise<T> {
  const structuredModel = model.withStructuredOutput(schema, { name: options.name });

  try {
    const result = await structuredModel.invoke(messages, {
      metadata: options.metadata
    });
    return result as T;
  } catch (firstError: any) {
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

      // Limpa marcações markdown ```json e ``` se presentes
      const cleaned = rawText
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/gi, "")
        .trim();

      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");

      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
        const jsonSubstring = cleaned.substring(firstBrace, lastBrace + 1);
        let parsed: any;
        try {
          parsed = JSON.parse(jsonSubstring);
        } catch (parseErr) {
          // Sanitize raw unescaped newlines/tabs within quotes
          const sanitized = jsonSubstring.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match: string) => {
            return match.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
          });
          parsed = JSON.parse(sanitized);
        }
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
