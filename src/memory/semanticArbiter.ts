import { z } from "zod";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { modelSemanticArbiter as model } from "../llm/model.js";
import { invokeStructuredWithFallback } from "../utils/structuredOutput.js";
import { logger } from "../utils/logger.js";
import { VectorMemoryRecord } from "./vectorMemory.js";

export const ArbiterDecisionSchema = z.object({
  candidateId: z.number().describe("ID da memória existente candidata."),
  action: z.enum(["KEEP", "UPDATE", "DELETE"]).default("KEEP").describe(
    "KEEP: informação compatível, complementar ou de outro sujeito. UPDATE: fato antigo precisa de esclarecimento ou rebaixamento. DELETE: contradição direta, anulação expressa ou fato obsoleto superado."
  ),
  updatedContent: z.string().nullable().default(null).describe("Novo texto do fato antigo caso action seja UPDATE. Deixar null se for KEEP ou DELETE."),
  updatedImportance: z.number().nullable().default(null).describe("Nova importância (0.0 a 1.0) se for UPDATE. Deixar null se mantiver."),
  reason: z.string().nullable().default(null).describe("Justificativa concisa da decisão semântica.")
});

export const ArbiterVerdictSchema = z.object({
  decisions: z.array(ArbiterDecisionSchema).default([]).describe("Decisões de arbitragem para cada um dos candidatos analisados."),
  shouldInsertNew: z.boolean().default(true).describe("Se o novo fato deve ser inserido (true na maioria dos casos; false se for duplicata idêntica ou redundante já contemplada)."),
  refinedContent: z.string().nullable().default(null).describe("Texto refinado/padronizado do novo fato, ou null para manter o original.")
});

export type ArbiterVerdict = z.infer<typeof ArbiterVerdictSchema>;

/**
 * Arbitra semanticamente um novo fato contra memórias candidatas potencialmente conflitantes.
 * 
 * Regras Fundamentais:
 * 1. Análise de Sujeito: Fatos sobre pessoas diferentes NUNCA se anulam (ex: "Manuela toca piano" vs "Luiz não toca piano" -> KEEP para Manuela).
 * 2. Precedência de Correções: Declarações negativas e correções explícitas do usuário ("não tenho pets", "não moro em Campinas", "não toco piano") têm precedência absoluta e forçam DELETE do fato anterior.
 * 3. Atualização/Refinamento: Se o fato novo expande ou substitui parcialmente um fato antigo, avalie se deve fazer UPDATE do antigo ou DELETE do obsoleto + INSERT do novo.
 * 4. Eficiência: Se não houver candidatos, retorna veredito limpo sem chamar LLM.
 */
export async function arbitrateMemoryCandidate(
  newContent: string,
  newCategory: string,
  candidates: VectorMemoryRecord[]
): Promise<ArbiterVerdict> {
  if (!candidates || candidates.length === 0) {
    return {
      decisions: [],
      shouldInsertNew: true,
      refinedContent: null
    };
  }

  const promptText = `
Você é o Árbitro Semântico de Memória Cognitiva da Bia (Assistente Pessoal).
Sua missão é analisar criticamente um NOVO FATO que está sendo gravado na memória em relação a MEMÓRIAS ANTIGAS já existentes no banco de dados e identificar possíveis contradições, duplicatas ou refinamentos.

NOVO FATO A SER GRAVADO:
- Categoria: ${newCategory}
- Conteúdo: "${newContent}"

MEMÓRIAS ANTIGAS CANDIDATAS (Encontradas por similaridade semântica):
${candidates.map((c) => `- [ID: ${c.id}] (Categoria: ${c.category}, Importância: ${c.importance}): "${c.content}"`).join("\n")}

DIRETRIZES DE ARBITRAGEM:
1. DISTINÇÃO DE SUJEITOS (MANDATÓRIO):
   - Fatos sobre entidades/pessoas distintas NUNCA entram em conflito.
   - Exemplo: Se o banco tem "A filha Manuela toca piano" e o novo fato é "Luiz não toca piano", a decisão para Manuela DEVE SER 'KEEP' (sujeitos diferentes).
2. PREVALÊNCIA DE DECLARAÇÕES NEGATIVAS E CORREÇÕES:
   - Se o novo fato nega ou corrige explicitamente algo anterior (ex: "Não tenho pets", "Não toco instrumento", "Mudei de empresa"), o fato anterior contraditório DEVE SER MARCADO COMO 'DELETE'.
3. TRATAMENTO DE REFINAMENTOS / ESPECIFICAÇÕES:
   - Se o novo fato apenas detalha o anterior (ex: "Mora em Campinas" vs "Mora no bairro Taquaral em Campinas"), você pode marcar o antigo como 'DELETE' e inserir o novo, ou 'UPDATE' para unificar.
4. DUPLICATAS EXATAS:
   - Se o novo fato for idêntico ou puramente redundante a um fato já existente com mesmo sentido, marque o candidato como 'KEEP' e 'shouldInsertNew: false'.
5. RETORNO ESTRUTURADO:
   - Retorne uma decisão para CADA UM dos candidatos listados acima (KEEP, UPDATE ou DELETE).
`;

  try {
    const verdict = await invokeStructuredWithFallback<ArbiterVerdict>(
      model,
      ArbiterVerdictSchema,
      [
        new SystemMessage("Você é o árbitro de coerência e reconciliação semântica da memória cognitiva. Seja cirúrgico e preserve memórias de outros sujeitos."),
        new HumanMessage(promptText)
      ],
      {
        name: "SemanticMemoryArbiter",
        metadata: { category: newCategory }
      }
    );

    logger.info(`[SEMANTIC_ARBITER] Decisão para novo fato "${newContent.slice(0, 40)}...": ` +
      `InsertNew=${verdict.shouldInsertNew}, Decisões=[${verdict.decisions.map(d => `${d.candidateId}:${d.action}`).join(", ")}]`);

    return verdict;
  } catch (error) {
    logger.error("[SEMANTIC_ARBITER] Falha na chamada do árbitro semântico. Prosseguindo com inserção segura.", error);
    // Em caso de falha no LLM, não bloqueia a gravação: faz inserção segura sem apagar nada
    return {
      decisions: candidates.map(c => ({
        candidateId: c.id,
        action: "KEEP",
        updatedContent: null,
        updatedImportance: null,
        reason: "Fallback por erro no árbitro"
      })),
      shouldInsertNew: true,
      refinedContent: null
    };
  }
}
