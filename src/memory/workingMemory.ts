import { listVectorMemories, searchVectorMemory, VectorMemoryRecord, getVectorDB } from './vectorMemory.js';
import { logger } from '../utils/logger.js';

export interface ScoredMemoryRecord extends VectorMemoryRecord {
  cognitiveScore: number;
  recencyScore: number;
  reinforcementScore: number;
  rrfScore?: number;
}

/**
 * Calcula a curva contínua de recência: R(Δt) = exp(-(Δt / τ)^γ)
 * @param lastAccessedAt Data do último acesso/reforço (ISO string ou Date)
 * @param now Data de referência (padrão: agora)
 * @param tauDays Meia-vida/escala temporal em dias (padrão: 7 dias)
 * @param gamma Taxa de amortecimento da curva (padrão: 0.8 para transição suave)
 */
export function calculateRecency(
  lastAccessedAt: string | Date,
  now: Date = new Date(),
  tauDays: number = 7,
  gamma: number = 0.8
): number {
  if (!lastAccessedAt) return 0.5;
  const lastDate = typeof lastAccessedAt === 'string' ? new Date(lastAccessedAt) : lastAccessedAt;
  const diffMs = now.getTime() - lastDate.getTime();
  const diffDays = Math.max(0, diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return 1.0;
  return Math.exp(-Math.pow(diffDays / tauDays, gamma));
}

/**
 * Calcula a função contínua de reforço/frequência: F(n) = 0.6 + 0.4 * (ln(n + 1) / ln(10))
 * @param accessCount Quantidade de vezes que a memória foi acessada ou reforçada (n >= 1)
 */
export function calculateReinforcement(accessCount: number = 1): number {
  const n = Math.max(1, accessCount || 1);
  const normalizedLog = Math.log(n + 1) / Math.log(10);
  return Math.min(1.0, 0.6 + 0.4 * normalizedLog);
}

/**
 * Calcula a pontuação cognitiva unificada contínua:
 * S(i, t) = I^2 + (1 - I^2) * R(Δt) * F(n)
 *
 * Para categorias de curto prazo ('conversa', 'contexto'), aplica um decay de sessão adicional
 * com meia-vida de 4 horas APENAS no componente dinâmico, preservando o piso perene I².
 *
 * - Fatos vitais (I = 1.0) mantêm S = 1.000 eternamente (piso perene imortal).
 * - Fatos recentes (R ≈ 1.0) competem no topo durante as primeiras horas/dias.
 * - Fatos reforçados (n > 1) sustentam alta ativação.
 * - Fatos de sessão ('conversa'/'contexto') decaem com meia-vida de 4h, não 7 dias.
 *
 * @param importance Importância intrínseca I (0.0–1.0)
 * @param lastAccessedAt Data do último acesso
 * @param accessCount Número de reforços
 * @param now Data de referência
 * @param category Categoria da memória — ativa decay duplo para 'conversa' e 'contexto'
 */
export function calculateCognitiveScore(
  importance: number = 0.5,
  lastAccessedAt: string | Date = new Date(),
  accessCount: number = 1,
  now: Date = new Date(),
  category?: string
): number {
  const I = Math.max(0.0, Math.min(1.0, typeof importance === 'number' ? importance : 0.5));
  const R = calculateRecency(lastAccessedAt, now);
  const F = calculateReinforcement(accessCount);

  const baseFloor = I * I;
  let dynamicComponent = (1.0 - baseFloor) * R * F;

  // MELHORIA 3 — Decay duplo de sessão: categorias de curto prazo decaem em ~4h, não 7 dias.
  // Aplica-se APENAS ao componente dinâmico: fatos com I=1.0 (baseFloor=1.0, dynamic=0) são imunes.
  if ((category === 'conversa' || category === 'contexto') && I < 0.85) {
    const lastDate = typeof lastAccessedAt === 'string' ? new Date(lastAccessedAt) : lastAccessedAt;
    const diffMs = Math.max(0, now.getTime() - lastDate.getTime());
    const diffHours = diffMs / (1000 * 60 * 60);
    const SESSION_TAU_HOURS = 4; // meia-vida de sessão: 4 horas
    const sessionDecay = Math.exp(-0.693 * diffHours / SESSION_TAU_HOURS);
    dynamicComponent = dynamicComponent * sessionDecay;
  }

  const finalScore = baseFloor + dynamicComponent;
  return Math.max(0.0, Math.min(1.0, finalScore));
}

/**
 * Avalia e ranqueia uma lista de memórias pela pontuação cognitiva contínua.
 * Passa a categoria da memória para ativar o decay duplo de sessão quando aplicável.
 */
export function rankMemories(memories: VectorMemoryRecord[], now: Date = new Date()): ScoredMemoryRecord[] {
  return memories.map((m) => {
    const recency = calculateRecency(m.lastAccessedAt || m.createdAt, now);
    const reinforcement = calculateReinforcement(m.accessCount || 1);
    const score = calculateCognitiveScore(
      m.importance ?? 0.5,
      m.lastAccessedAt || m.createdAt,
      m.accessCount || 1,
      now,
      m.category  // MELHORIA 3: passa a categoria para ativar decay de sessão
    );

    return {
      ...m,
      recencyScore: recency,
      reinforcementScore: reinforcement,
      cognitiveScore: score,
    };
  }).sort((a, b) => b.cognitiveScore - a.cognitiveScore);
}

/**
 * MELHORIA 1 — Reciprocal Rank Fusion (RRF).
 * Combina dois rankings de memórias em um ranking unificado que pondera tanto
 * recência/cobertura (Canal A) quanto relevância semântica (Canal B).
 *
 * score_rrf(d) = Σ 1 / (k + rank(d) em cada ranking)
 *
 * @param rankingA Ranking por recência/cobertura (listVectorMemories)
 * @param rankingB Ranking por similaridade semântica (searchVectorMemory)
 * @param k Constante de suavização (padrão: 60 — padrão da literatura)
 * @returns Lista deduplicada por id, ordenada por score RRF decrescente
 */
export function reciprocalRankFusion(
  rankingA: VectorMemoryRecord[],
  rankingB: VectorMemoryRecord[],
  k: number = 60
): VectorMemoryRecord[] {
  const scoreMap = new Map<number, { record: VectorMemoryRecord; rrfScore: number }>();

  // Processa Canal A: recência/cobertura
  rankingA.forEach((mem, idx) => {
    const rrfScore = 1 / (k + idx + 1);
    scoreMap.set(mem.id, { record: mem, rrfScore });
  });

  // Processa Canal B: semântica — soma ao score existente ou cria novo
  rankingB.forEach((mem, idx) => {
    const rrfScore = 1 / (k + idx + 1);
    const existing = scoreMap.get(mem.id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      scoreMap.set(mem.id, { record: mem, rrfScore });
    }
  });

  // Ordena por score RRF decrescente e retorna os records
  return Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map((entry) => entry.record);
}

/**
 * MELHORIA 2 — Monta o bloco de Working Memory com 3 slots segmentados e budgets alocados.
 *
 * Slots:
 * - Core (30% do budget): Fatos de perfil vital (importance >= 0.85 ou category === 'perfil').
 *   Sempre presentes; budget overflow passa ao próximo slot.
 * - Sessão (25% do budget): Fatos acessados nas últimas 4 horas. Ordenados por lastAccessedAt DESC.
 * - Relevância (45% + overflow): Demais fatos, ordenados por cognitiveScore DESC.
 *
 * @param memories Lista de memórias já ranqueadas (ScoredMemoryRecord[])
 * @param maxTokens Orçamento total em tokens
 * @returns Bloco Markdown pronto para injeção no prompt
 */
export function buildSlottedWorkingMemory(
  memories: ScoredMemoryRecord[],
  maxTokens: number = 5000
): string {
  const maxChars = maxTokens * 4;
  const now = new Date();
  const SESSION_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 horas

  // Separação por slot (sem duplicatas entre slots)
  const coreSet = new Set<number>();
  const sessionSet = new Set<number>();

  const coreMemories: ScoredMemoryRecord[] = [];
  const sessionMemories: ScoredMemoryRecord[] = [];
  const relevanceMemories: ScoredMemoryRecord[] = [];

  for (const mem of memories) {
    if (mem.importance >= 0.85 || mem.category === 'perfil') {
      coreMemories.push(mem);
      coreSet.add(mem.id);
    }
  }

  for (const mem of memories) {
    if (coreSet.has(mem.id)) continue;
    const accessTime = new Date(mem.lastAccessedAt || mem.createdAt).getTime();
    if (now.getTime() - accessTime <= SESSION_WINDOW_MS) {
      sessionMemories.push(mem);
      sessionSet.add(mem.id);
    }
  }

  // Sessão: ordenar por mais recente primeiro
  sessionMemories.sort((a, b) =>
    new Date(b.lastAccessedAt || b.createdAt).getTime() -
    new Date(a.lastAccessedAt || a.createdAt).getTime()
  );

  for (const mem of memories) {
    if (!coreSet.has(mem.id) && !sessionSet.has(mem.id)) {
      relevanceMemories.push(mem);
    }
  }
  // Relevância: já ordenado por cognitiveScore DESC de rankMemories()

  // Alocação de budget com overflow entre slots
  const CORE_RATIO = 0.30;
  const SESSION_RATIO = 0.25;
  const RELEVANCE_RATIO = 0.45;

  let coreChars = maxChars * CORE_RATIO;
  let sessionChars = maxChars * SESSION_RATIO;
  let relevanceChars = maxChars * RELEVANCE_RATIO;

  // Função helper de corte por budget
  function fillSlot(
    candidates: ScoredMemoryRecord[],
    budget: number,
    allowOverflowForImmortal = false
  ): { selected: ScoredMemoryRecord[]; used: number } {
    const selected: ScoredMemoryRecord[] = [];
    let used = 0;
    const seen = new Set<string>();

    for (const mem of candidates) {
      const normalized = mem.content.trim().toLowerCase().replace(/[*\-_#]/g, '').replace(/\s+/g, ' ');
      if (normalized.length < 3 || seen.has(normalized)) continue;
      seen.add(normalized);

      const estLen = mem.content.length + 20;
      if (used + estLen <= budget) {
        selected.push(mem);
        used += estLen;
      } else if (allowOverflowForImmortal && mem.importance >= 0.95) {
        // Fatos vitais (I >= 0.95) nunca são descartados
        selected.push(mem);
        used += estLen;
      }
    }
    return { selected, used };
  }

  const { selected: coreSelected, used: coreUsed } = fillSlot(coreMemories, coreChars, true);
  // Budget não usado no Core vai para Sessão
  const coreOverflow = Math.max(0, coreChars - coreUsed);
  sessionChars += coreOverflow;

  const { selected: sessionSelected, used: sessionUsed } = fillSlot(sessionMemories, sessionChars);
  // Budget não usado na Sessão vai para Relevância
  const sessionOverflow = Math.max(0, sessionChars - sessionUsed);
  relevanceChars += sessionOverflow;

  const { selected: relevanceSelected } = fillSlot(relevanceMemories, relevanceChars);

  // Renderização em Markdown
  let output = '';

  if (coreSelected.length > 0) {
    output += '## 👤 Perfil & Fatos Perenes\n';
    coreSelected.forEach((f) => { output += `- ${f.content}\n`; });
    output += '\n';
  }

  if (sessionSelected.length > 0) {
    output += '## ⚡ Contexto da Sessão Atual\n';
    sessionSelected.forEach((f) => { output += `- ${f.content}\n`; });
    output += '\n';
  }

  if (relevanceSelected.length > 0) {
    output += '## 🧠 Memória de Longo Prazo\n';
    relevanceSelected.forEach((f) => { output += `- ${f.content}\n`; });
    output += '\n';
  }

  return output.trim();
}

/**
 * Busca o snapshot mais recente compilado pelo consolidator no SQLite.
 */
export async function getCachedWorkingMemorySnapshot(chatJid: string): Promise<string | null> {
  const db = getVectorDB();
  return new Promise((resolve) => {
    db.get(
      `SELECT snapshot FROM working_memory_snapshot WHERE chat_jid = ?`,
      [chatJid],
      (err, row: any) => {
        if (err || !row || !row.snapshot) {
          resolve(null);
        } else {
          resolve(row.snapshot);
        }
      }
    );
  });
}

/**
 * Busca a data da última consolidação do snapshot da memória de trabalho.
 */
export async function getSnapshotUpdatedAt(chatJid: string): Promise<Date | null> {
  const db = getVectorDB();
  return new Promise((resolve) => {
    db.get(
      `SELECT updated_at FROM working_memory_snapshot WHERE chat_jid = ?`,
      [chatJid],
      (err, row: any) => {
        if (err || !row || !row.updated_at) {
          resolve(null);
        } else {
          try {
            const parsed = new Date(row.updated_at);
            resolve(isNaN(parsed.getTime()) ? null : parsed);
          } catch {
            resolve(null);
          }
        }
      }
    );
  });
}

/**
 * Salva um snapshot consolidado da memória de trabalho.
 */
export async function saveWorkingMemorySnapshot(chatJid: string, snapshot: string, metadata?: Record<string, any>): Promise<void> {
  const db = getVectorDB();
  const now = new Date().toISOString();
  const metaStr = metadata ? JSON.stringify(metadata) : null;

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO working_memory_snapshot (chat_jid, snapshot, updated_at, metadata)
       VALUES (?, ?, ?, ?)`,
      [chatJid, snapshot, now, metaStr],
      (err) => {
        if (err) {
          logger.error('[WORKING_MEMORY] Erro ao salvar snapshot de memória:', err);
          return reject(err);
        }
        resolve();
      }
    );
  });
}

/**
 * Compila a Memória de Trabalho Orgânica (Working Memory) para injeção no contexto da Supervisora.
 *
 * MELHORIAS IMPLEMENTADAS:
 * 1. Retrieval Híbrido com RRF: quando `query` for fornecida, combina busca por recência (Canal A)
 *    com busca semântica vetorial (Canal B) via Reciprocal Rank Fusion.
 * 2. Slots Reservados: monta o bloco com 3 slots segmentados (Core 30%, Sessão 25%, Relevância 45%)
 *    quando não há snapshot consolidado disponível.
 * 3. Fatos de sessão ('conversa'/'contexto') têm decay duplo de 4h aplicado no rankMemories().
 *
 * @param chatJid JID do chat atual
 * @param isTrustedChat Se o chat é confiável (acesso à memória global) ou não (isolado)
 * @param maxTokens Orçamento aproximado de tokens (padrão: 5000 tokens)
 * @param now Data de referência
 * @param query Mensagem do usuário para retrieval semântico (ativa Melhoria 1)
 */
export async function getWorkingMemoryContext(
  chatJid: string = 'global',
  isTrustedChat: boolean = true,
  maxTokens: number = 5000,
  now: Date = new Date(),
  query?: string  // MELHORIA 1: parâmetro opcional — não passa = comportamento legado
): Promise<string> {
  try {
    // 1. Verifica se existe snapshot consolidado cacheado
    const snapshotKey = isTrustedChat ? 'global' : chatJid;
    const cachedSnapshot = await getCachedWorkingMemorySnapshot(snapshotKey);

    // MELHORIA 1 — Retrieval Híbrido com RRF
    // Quando query disponível: busca em paralelo por recência (Canal A) + semântica (Canal B)
    // Quando sem query: comportamento legado (só Canal A com 600 registros)
    let rawMemories: VectorMemoryRecord[];

    if (query && query.trim().length > 2) {
      const [canalA, canalB] = await Promise.all([
        listVectorMemories(300, chatJid, isTrustedChat),
        searchVectorMemory(query.trim(), 50, chatJid, isTrustedChat).catch((err) => {
          logger.warn('[WORKING_MEMORY] Busca semântica (Canal B) falhou, usando só Canal A:', err);
          return [] as VectorMemoryRecord[];
        }),
      ]);
      rawMemories = reciprocalRankFusion(canalA, canalB, 60);
    } else {
      rawMemories = await listVectorMemories(600, chatJid, isTrustedChat);
    }

    if (!rawMemories || rawMemories.length === 0) {
      if (cachedSnapshot) return cachedSnapshot;
      return isTrustedChat
        ? "Nenhum dado de memória registrado ainda."
        : `Nenhuma anotação registrada para este chat (${chatJid}).`;
    }

    // 2. Ranqueia todos os fatos pela equação de ativação cognitiva
    // (inclui decay duplo de sessão para categorias 'conversa'/'contexto' — Melhoria 3)
    const scoredMemories = rankMemories(rawMemories, now);

    // Se houver snapshot consolidado no banco, combina ele com fatos novos/recentes não presentes no snapshot
    if (cachedSnapshot && cachedSnapshot.trim().length > 20) {
      const snapshotDate = await getSnapshotUpdatedAt(snapshotKey);
      const maxChars = maxTokens * 4;
      let remainingChars = maxChars - cachedSnapshot.length;

      // Filtra fatos que já estão contidos no snapshot ou que não são suficientemente recentes/ativos
      const nonSnapshotMemories = scoredMemories.filter((m) => {
        const snippet = m.content.toLowerCase().slice(0, 30).trim();
        const isAlreadyInSnapshot = snippet.length >= 5 && cachedSnapshot.toLowerCase().includes(snippet);
        if (isAlreadyInSnapshot) return false;

        const memDate = new Date(m.updatedAt || m.createdAt || m.lastAccessedAt);
        const isPostSnapshot = snapshotDate ? memDate.getTime() > snapshotDate.getTime() : true;
        const isHighActivation = m.recencyScore >= 0.65 || m.cognitiveScore >= 0.7;

        return isPostSnapshot || isHighActivation;
      });

      // MELHORIA 2 — ao combinar com snapshot, a seção de fatos recentes usa
      // prioridade: sessão (últimas 4h) primeiro, depois por score cognitivo
      const SESSION_WINDOW_MS = 4 * 60 * 60 * 1000;
      const nowMs = now.getTime();
      const sortedNonSnapshot = [...nonSnapshotMemories].sort((a, b) => {
        const aIsSession = nowMs - new Date(a.lastAccessedAt || a.createdAt).getTime() <= SESSION_WINDOW_MS;
        const bIsSession = nowMs - new Date(b.lastAccessedAt || b.createdAt).getTime() <= SESSION_WINDOW_MS;
        if (aIsSession && !bIsSession) return -1;
        if (!aIsSession && bIsSession) return 1;
        return b.cognitiveScore - a.cognitiveScore;
      });

      const memoriesToAdd: ScoredMemoryRecord[] = [];
      for (const mem of sortedNonSnapshot) {
        const estLen = mem.content.length + 10;
        if (remainingChars - estLen >= 0) {
          memoriesToAdd.push(mem);
          remainingChars -= estLen;
        }
      }

      if (memoriesToAdd.length > 0) {
        let combined = cachedSnapshot.trim() + "\n\n## 🔄 Contexto & Fatos Recentes\n";
        memoriesToAdd.forEach((f) => {
          combined += `- ${f.content}\n`;
        });
        return combined.trim();
      }

      return cachedSnapshot.trim();
    }

    // MELHORIA 2 — Sem snapshot: usa sistema de slots segmentados
    return buildSlottedWorkingMemory(scoredMemories, maxTokens);

  } catch (error) {
    logger.error('[WORKING_MEMORY] Erro ao compilar memória de trabalho:', error);
    return "Erro ao compilar memória de trabalho.";
  }
}
