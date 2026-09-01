import { z } from "zod";

/**
 * Utilitário para campos opcionais em schemas Zod compatíveis com OpenAI/DeepSeek Strict Mode.
 *
 * ## Problema
 * `.optional()` no Zod gera campos sem entrada no array `required` do JSON Schema.
 * Provedores como OpenAI e DeepSeek no modo estrito **rejeitam** schemas com campos
 * fora do `required`, lançando HTTP 400.
 *
 * ## Solução
 * Use `strictOptional(z.string())` ao invés de `z.string().optional()`.
 * Isso garante que o campo seja `required` (pois `nullable` sem `optional` é required),
 * mas aceita `null` como valor — que o LLM pode enviar livremente.
 *
 * ## Exemplo
 * ```ts
 * import { strictOptional } from "../utils/zodStrict.js";
 *
 * const MySchema = z.object({
 *   name: z.string(),
 *   nickname: strictOptional(z.string()),  // Campo opcional mas strict-compatible
 *   score: strictOptional(z.number()),
 * });
 * ```
 *
 * ## Regra de uso obrigatória
 * Em TODOS os schemas Zod usados com `withStructuredOutput` ou `invokeStructuredWithFallback`:
 * - ❌ NUNCA use `.optional()` sem `.nullable().default(null)`
 * - ✅ Use `strictOptional(schema)` para campos opcionais
 * - ✅ Use `.nullable().default(null)` diretamente (equivalente manual)
 * - ✅ Use `.default([])` em arrays que podem ser omitidos pelo LLM
 */
export function strictOptional<T extends z.ZodType>(schema: T) {
  return schema.nullable().default(null);
}

/**
 * Cria um array Zod compatível com strict mode que não quebra quando o LLM
 * omite o campo (default: lista vazia) ou retorna um único elemento ao invés
 * de um array (normalizado pelo `normalizePayload` em structuredOutput.ts).
 *
 * ## Exemplo
 * ```ts
 * const MySchema = z.object({
 *   tags: strictArray(z.string()),  // Em vez de z.array(z.string())
 * });
 * ```
 */
export function strictArray<T extends z.ZodType>(itemSchema: T) {
  return z.array(itemSchema).default([]);
}
