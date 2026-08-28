import { describe, test, expect, beforeAll } from '@jest/globals';
import { 
  calculateRecency, 
  calculateReinforcement, 
  calculateCognitiveScore, 
  rankMemories,
  getWorkingMemoryContext,
  saveWorkingMemorySnapshot,
  getCachedWorkingMemorySnapshot
} from '../../src/memory/workingMemory.js';
import { initVectorMemory, addVectorMemory, deleteVectorMemory, listVectorMemories } from '../../src/memory/vectorMemory.js';
import { setAIClient } from '../../src/memory/embeddings.js';

describe("Cognitive Working Memory Engine", () => {
  const testChatJid = "test-working-memory@s.whatsapp.net";

  beforeAll(async () => {
    setAIClient({
      models: {
        embedContent: async () => ({
          embeddings: [{ values: new Array(3072).fill(0.1) }]
        })
      }
    });
    await initVectorMemory();
  });

  describe("Continuous Mathematical Functions", () => {
    test("calculateRecency deve decair suavemente com o tempo", () => {
      const now = new Date("2026-08-25T12:00:00.000Z");

      // Recência imediata (agora)
      const r0 = calculateRecency(now, now);
      expect(r0).toBeCloseTo(1.0, 2);

      // Recência após 6 horas
      const r6h = calculateRecency(new Date("2026-08-25T06:00:00.000Z"), now);
      expect(r6h).toBeGreaterThan(0.90);

      // Recência após 1 dia (24h)
      const r1d = calculateRecency(new Date("2026-08-24T12:00:00.000Z"), now);
      expect(r1d).toBeGreaterThan(0.80);

      // Recência após 7 dias (meia-vida)
      const r7d = calculateRecency(new Date("2026-08-18T12:00:00.000Z"), now);
      expect(r7d).toBeCloseTo(Math.exp(-1), 1); // ~0.368

      // Recência após 30 dias
      const r30d = calculateRecency(new Date("2026-07-26T12:00:00.000Z"), now);
      expect(r30d).toBeLessThan(0.1);
    });

    test("calculateReinforcement deve aumentar logaritmicamente com accessCount", () => {
      const f1 = calculateReinforcement(1);
      expect(f1).toBeGreaterThanOrEqual(0.6);
      expect(f1).toBeLessThan(0.8);

      const f3 = calculateReinforcement(3);
      expect(f3).toBeGreaterThan(f1);

      const f9 = calculateReinforcement(9);
      expect(f9).toBeCloseTo(1.0, 1);
    });

    test("calculateCognitiveScore deve garantir perenidade para I = 1.0", () => {
      const now = new Date("2026-08-25T12:00:00.000Z");
      const veryOldDate = new Date("2020-01-01T00:00:00.000Z");

      // Fato vital com I = 1.0 (mesmo de anos atrás)
      const scoreVital = calculateCognitiveScore(1.0, veryOldDate, 1, now);
      expect(scoreVital).toBeCloseTo(1.0, 3);
    });

    test("calculateCognitiveScore deve manter fatos banais recentes no topo e decair com o tempo", () => {
      const now = new Date("2026-08-25T12:00:00.000Z");
      const todayDate = new Date("2026-08-25T10:00:00.000Z");
      const oldDate = new Date("2026-07-25T10:00:00.000Z");

      // Fato banal de hoje (I = 0.2, 2 horas atrás)
      const scoreToday = calculateCognitiveScore(0.2, todayDate, 1, now);
      expect(scoreToday).toBeGreaterThan(0.65);

      // Fato banal de 1 mês atrás (I = 0.2)
      const scoreOld = calculateCognitiveScore(0.2, oldDate, 1, now);
      expect(scoreOld).toBeLessThan(0.2);
    });

    test("calculateCognitiveScore deve premiar memórias reforçadas", () => {
      const now = new Date("2026-08-25T12:00:00.000Z");
      const pastDate = new Date("2026-08-15T12:00:00.000Z");

      const scoreLowAccess = calculateCognitiveScore(0.5, pastDate, 1, now);
      const scoreHighAccess = calculateCognitiveScore(0.5, pastDate, 8, now);

      expect(scoreHighAccess).toBeGreaterThan(scoreLowAccess);
    });
  });

  describe("Working Memory Context Compilation", () => {
    test("rankMemories deve ordenar memórias pela pontuação cognitiva decrescente", () => {
      const now = new Date("2026-08-25T12:00:00.000Z");
      const mockMemories: any[] = [
        { id: 1, content: "Fato banal antigo", importance: 0.1, lastAccessedAt: "2026-06-01T00:00:00.000Z", accessCount: 1 },
        { id: 2, content: "Fato vital", importance: 1.0, lastAccessedAt: "2025-01-01T00:00:00.000Z", accessCount: 1 },
        { id: 3, content: "Fato de hoje", importance: 0.3, lastAccessedAt: "2026-08-25T11:00:00.000Z", accessCount: 1 }
      ];

      const ranked = rankMemories(mockMemories, now);
      expect(ranked[0].id).toBe(2); // Fato vital no topo (score = 1.0)
      expect(ranked[1].id).toBe(3); // Fato de hoje em segundo
      expect(ranked[2].id).toBe(1); // Fato banal antigo no fim
    });

    test("getWorkingMemoryContext deve compilar as seções de memória", async () => {
      await addVectorMemory("Luiz mora em Campinas com a família", "perfil", testChatJid, undefined, 1.0);
      await addVectorMemory("Almoço de hoje foi pizza", "anotacao", testChatJid, undefined, 0.3);

      const context = await getWorkingMemoryContext(testChatJid, true);
      expect(context).toContain("Perfil & Fatos Perenes");
      expect(context).toContain("Luiz mora em Campinas com a família");
    });

    test("saveWorkingMemorySnapshot e getCachedWorkingMemorySnapshot devem persistir no SQLite", async () => {
      const snapContent = "# Snapshot Consolidado de Teste\n- Família reunida.";
      await saveWorkingMemorySnapshot(testChatJid, snapContent);

      const cached = await getCachedWorkingMemorySnapshot(testChatJid);
      expect(cached).toBe(snapContent);
    });

    test("cleanup de dados de teste", async () => {
      const list = await listVectorMemories(100, testChatJid, false);
      for (const item of list) {
        await deleteVectorMemory(item.id);
      }
    });
  });
});
