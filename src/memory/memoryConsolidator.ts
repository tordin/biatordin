import cron from 'node-cron';
import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { modelEvaluator as model } from '../llm/model.js';
import { invokeStructuredWithFallback } from '../utils/structuredOutput.js';
import { listVectorMemories, batchDeleteVectorMemories, batchUpdateImportance } from './vectorMemory.js';
import { rankMemories, getCachedWorkingMemorySnapshot, saveWorkingMemorySnapshot } from './workingMemory.js';
import { logger } from '../utils/logger.js';

export const DemoteItemSchema = z.object({
  id: z.number().describe("ID da memória a ser rebaixada"),
  newImportance: z.number().min(0.0).max(1.0).nullable().default(null).describe("Nova importância reduzida (ex: 0.1 a 0.3) para fatos antigos ou transitórios superados.")
});

export const ConsolidationResultSchema = z.object({
  consolidatedMarkdown: z.string().describe("O snapshot Markdown sintetizado, coeso, hierarquizado e limpo."),
  purgeIds: z.array(z.number()).nullable().default([]).describe("Array com os IDs das memórias que devem ser EXPURGADAS do banco SQLite (contradições diretas, fatos cancelados/superados, erros)."),
  demoteIds: z.array(DemoteItemSchema).nullable().default([]).describe("Lista de memórias cujo valor de importância deve ser rebaixado.")
});

export type ConsolidationResult = z.infer<typeof ConsolidationResultSchema>;

/**
 * Executa o Garbage Collector na base de memórias: expurga itens transitórios antigos e esquecidos.
 * Preserva 100% de fatos de perfil (imortais).
 */
export async function runMemoryGarbageCollector(
  chatJid: string = 'global',
  isTrustedChat: boolean = true,
  maxAgeDays: number = 90
): Promise<number> {
  try {
    const rawMemories = await listVectorMemories(500, chatJid, isTrustedChat);
    if (!rawMemories || rawMemories.length === 0) return 0;

    const scored = rankMemories(rawMemories);
    const now = Date.now();
    const purgeCandidateIds: number[] = [];

    for (const mem of scored) {
      // Regra 1: Fatos de perfil são imortais, NUNCA expurgar no GC
      if (mem.category === 'perfil' || mem.importance >= 0.9) {
        continue;
      }

      const createdTime = new Date(mem.createdAt).getTime();
      const ageDays = (now - createdTime) / (1000 * 60 * 60 * 24);

      // Regra 2: Apenas itens antigos (> 90 dias), com baixa importância (< 0.3), sem reforço e score cognitivo ínfimo (< 0.05)
      if (ageDays >= maxAgeDays && mem.importance < 0.3 && mem.accessCount <= 1 && mem.cognitiveScore < 0.05) {
        purgeCandidateIds.push(mem.id);
      }
    }

    if (purgeCandidateIds.length > 0) {
      logger.info(`[MEMORY_GC] Expurgo de ${purgeCandidateIds.length} memórias obsoletas/esquecidas: [${purgeCandidateIds.join(', ')}]`);
      await batchDeleteVectorMemories(purgeCandidateIds);
      return purgeCandidateIds.length;
    }

    return 0;
  } catch (error) {
    logger.error('[MEMORY_GC] Erro durante a execução do Garbage Collector de memória:', error);
    return 0;
  }
}

/**
 * Consolida a memória de trabalho gerando um snapshot sintetizado e rico via LLM de forma BIDIRECIONAL:
 * sintetiza o Markdown e higieniza a base relacional (expurgo de contradições e demote de fatos superados).
 */
export async function consolidateWorkingMemorySnapshot(
  chatJid: string = 'global',
  isTrustedChat: boolean = true
): Promise<string> {
  try {
    logger.info(`[MEMORY_CONSOLIDATOR] Iniciando consolidação bidirecional de memória para ${chatJid}...`);

    // 1. Busca fatos candidatos no SQLite
    const rawMemories = await listVectorMemories(500, chatJid, isTrustedChat);
    if (!rawMemories || rawMemories.length === 0) {
      logger.info(`[MEMORY_CONSOLIDATOR] Nenhuma memória encontrada para consolidação em ${chatJid}.`);
      return "Nenhuma memória registrada.";
    }

    // 2. Ranqueia os fatos pela equação de ativação cognitiva
    const scoredMemories = rankMemories(rawMemories);
    // Pega os top 180 fatos mais bem pontuados para ampla cobertura e síntese densa
    const topMemories = scoredMemories.slice(0, 180);

    const previousSnapshot = (await getCachedWorkingMemorySnapshot(chatJid)) || "Nenhum snapshot anterior.";

    const promptText = `
Você é o Consolidador de Memória Cognitiva da Bia (Assistente Pessoal).
Sua missão é realizar a "Consolidação de Sono" (Memory Consolidation) de forma BIDIRECIONAL:
1. Leia os fatos brutos com maior pontuação cognitiva da base e o snapshot anterior.
2. Sintetize um NOVO SNAPSHOT de Memória de Trabalho unificado, coeso, elegante e denso em Markdown.
3. Identifique quais IDs de memórias brutas são CONTRADIÇÕES DIRETAS, FATOS SUPERADOS ou ERROS e devem ser EXPURGADOS (purgeIds) do banco de dados relacional.
4. Identifique quais IDs devem ter sua importância REBAIXADA (demoteIds) para fatos transitórios ou parcialmente obsoletos.

REGRA DE OURO DA CONSOLIDAÇÃO:
- Declarações negativas e correções explícitas (ex: "NÃO tem pets", "NÃO toca piano", "NÃO trabalha mais na Empresa X") têm PRECEDÊNCIA ABSOLUTA sobre afirmações antigas.
- O fato antigo incorreto DEVE constar na lista 'purgeIds' para ser removido definitivamente do banco SQLite e da busca vetorial RAG.
- Fatos de sujeitos diferentes (ex: "Manuela toca piano" vs "Luiz não toca piano") NUNCA são contradições e DEVEM ser preservados.
- DATAS COMEMORATIVAS & ANIVERSÁRIOS: Verifique e mantenha as datas exatas e completas de cada membro individual da família (Luiz, Luciana, Manuela, Cecilia). NUNCA confunda o aniversário das filhas ou da esposa com o do Luiz.

PRESERVAÇÃO DE PERFIL VITAL:
- Todos os dados vitais de perfil atualizados (nome, família, filhos, cônjuge, residência, trabalho, hobbies) DEVEM constar no Markdown final de forma estruturada.

SNAPSHOT ANTERIOR:
${previousSnapshot}

FATOS BRUTOS MAIS RELEVANTES (Ordenados por Ativação Cognitiva):
${topMemories.map((m) => `- [ID: ${m.id}] [${m.category.toUpperCase()}] (Importância: ${m.importance}, Acessos: ${m.accessCount}): "${m.content}"`).join('\n')}
`;

    const result = await invokeStructuredWithFallback<ConsolidationResult>(
      model,
      ConsolidationResultSchema,
      [
        new SystemMessage("Você é o motor de consolidação e higienização da memória cognitiva da Bia. Seja analítico, resolva contradições e expurgue fatos obsoletos."),
        new HumanMessage(promptText)
      ],
      {
        name: "MemoryConsolidatorSleep",
        metadata: { chatJid }
      }
    );

    const consolidatedSnapshot = result.consolidatedMarkdown.trim();

    const purgeIds = result.purgeIds || [];
    const demoteIds = (result.demoteIds || []).map(d => ({
      id: d.id,
      newImportance: d.newImportance ?? 0.2
    }));

    // 3. Salva no SQLite o novo snapshot consolidado
    await saveWorkingMemorySnapshot(chatJid, consolidatedSnapshot, {
      consolidatedAt: new Date().toISOString(),
      memoriesCount: topMemories.length,
      purgedCount: purgeIds.length,
      demotedCount: demoteIds.length
    });

    // 4. Higienização Bidirecional: Expurga memórias descartadas pelo LLM
    if (purgeIds.length > 0) {
      logger.info(`[MEMORY_CONSOLIDATOR] Expurgando ${purgeIds.length} memórias contraditórias/superadas do SQLite: [${purgeIds.join(', ')}]`);
      await batchDeleteVectorMemories(purgeIds);
    }

    // 5. Rebaixa a importância das memórias solicitadas
    if (demoteIds.length > 0) {
      logger.info(`[MEMORY_CONSOLIDATOR] Rebaixando importância de ${demoteIds.length} memórias.`);
      await batchUpdateImportance(demoteIds);
    }

    // 6. Roda o Garbage Collector para descarte de resíduos antigos
    await runMemoryGarbageCollector(chatJid, isTrustedChat);

    logger.info(`[MEMORY_CONSOLIDATOR] Snapshot consolidado com sucesso para ${chatJid} (${consolidatedSnapshot.length} chars).`);
    return consolidatedSnapshot;
  } catch (error) {
    logger.error(`[MEMORY_CONSOLIDATOR] Erro ao consolidar snapshot para ${chatJid}:`, error);
    throw error;
  }
}

/**
 * Agenda a consolidação diária automática às 03:00 da manhã.
 */
export function scheduleDailyMemoryConsolidation(): void {
  // Roda todos os dias às 03:05 da manhã (logo após a higienização de logs)
  cron.schedule('5 3 * * *', async () => {
    try {
      logger.info('[MEMORY_CONSOLIDATOR] Disparando consolidação noturna automática da memória da Bia...');
      await consolidateWorkingMemorySnapshot('global', true);
    } catch (e) {
      logger.error('[MEMORY_CONSOLIDATOR] Falha na consolidação diária agendada:', e);
    }
  });

  logger.info('[MEMORY_CONSOLIDATOR] Agendamento de consolidação diária ativado (03:05 AM).');
}
