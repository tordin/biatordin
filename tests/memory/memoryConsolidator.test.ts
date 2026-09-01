import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { 
  consolidateWorkingMemorySnapshot, 
  runMemoryGarbageCollector 
} from '../../src/memory/memoryConsolidator.js';
import { 
  initVectorMemory, 
  addVectorMemory, 
  deleteVectorMemory, 
  listVectorMemories 
} from '../../src/memory/vectorMemory.js';
import { getCachedWorkingMemorySnapshot } from '../../src/memory/workingMemory.js';
import { setAIClient } from '../../src/memory/embeddings.js';
import { modelEvaluator as model } from '../../src/llm/model.js';

describe("Memory Consolidator (Bidirectional Sleep Consolidation & GC)", () => {
  const testChatJid = "test-consolidator@s.whatsapp.net";

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

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test("deve sintetizar snapshot e expurgar IDs de contradições do SQLite (bidirecional)", async () => {
    const id1 = await addVectorMemory("Luiz mora em Campinas", "perfil", testChatJid, undefined, 1.0);
    const id2 = await addVectorMemory("Luiz se mudou para São Paulo", "perfil", testChatJid, undefined, 1.0);
    const id3 = await addVectorMemory("Trabalha no iFood", "perfil", testChatJid, undefined, 1.0);

    const mockSnapshot = "# Perfil Consolidado\n- Luiz mora em São Paulo e trabalha no iFood.";

    const mockResult = {
      consolidatedMarkdown: mockSnapshot,
      purgeIds: [id1], // Fato de morar em Campinas foi superado
      demoteIds: []
    };

    jest.spyOn(model, "withStructuredOutput").mockReturnValue({
      invoke: async () => mockResult
    } as any);

    const snapshot = await consolidateWorkingMemorySnapshot(testChatJid, true);
    expect(snapshot).toBe(mockSnapshot);

    const cached = await getCachedWorkingMemorySnapshot(testChatJid);
    expect(cached).toBe(mockSnapshot);

    // Verifica que id1 foi purgado do banco relacional
    const list = await listVectorMemories(100, testChatJid, true);
    const hasId1 = list.some(m => m.id === id1);
    const hasId2 = list.some(m => m.id === id2);

    expect(hasId1).toBe(false);
    expect(hasId2).toBe(true);

    // Limpeza
    for (const item of list) {
      await deleteVectorMemory(item.id);
    }
  });

  test("deve executar Garbage Collector e purgar fatos antigos esquecidos preservando perfil", async () => {
    // 1. Memória de perfil (NUNCA purgada)
    const profileId = await addVectorMemory("Luiz é programador", "perfil", testChatJid, undefined, 1.0);

    // 2. Memória recente importante (NÃO purgada)
    const recentImportantId = await addVectorMemory("Reunião estratégica marcada", "fato", testChatJid, undefined, 0.8);

    const purgedCount = await runMemoryGarbageCollector(testChatJid, true, 90);
    expect(purgedCount).toBe(0);

    const list = await listVectorMemories(100, testChatJid, true);
    expect(list.some(m => m.id === profileId)).toBe(true);
    expect(list.some(m => m.id === recentImportantId)).toBe(true);

    for (const item of list) {
      await deleteVectorMemory(item.id);
    }
  });

  test("deve aceitar payload de consolidação parcial omitindo purgeIds e demoteIds sem erro de validação Zod", async () => {
    const memId = await addVectorMemory("Fato para consolidação", "fato", testChatJid, undefined, 0.9);
    const mockSnapshot = "# Snapshot Parcial\n- Fato mantido.";
    const mockResult = {
      consolidatedMarkdown: mockSnapshot
      // purgeIds e demoteIds omitidos
    };

    jest.spyOn(model, "withStructuredOutput").mockReturnValue({
      invoke: async () => mockResult
    } as any);

    const snapshot = await consolidateWorkingMemorySnapshot(testChatJid, true);
    expect(snapshot).toBe(mockSnapshot);

    await deleteVectorMemory(memId);
  });

  test("deve se recuperar no fallback quando o LLM retorna snapshot como objeto JSON em vez de string", async () => {
    const memId = await addVectorMemory("Fato para teste de fallback", "fato", testChatJid, undefined, 0.9);

    // Simula erro no parser nativo
    jest.spyOn(model, "withStructuredOutput").mockReturnValue({
      invoke: jest.fn<any>().mockRejectedValue(new Error("400 Invalid schema for response_format"))
    } as any);

    // Simula resposta bruta do modelo com snapshot em formato de objeto JSON
    const rawFallbackResponse = {
      content: JSON.stringify({
        snapshot: {
          perfil: { nome: "Luiz", residencia: "Campinas" },
          interesses: "Tecnologia e IA"
        },
        purgeIds: [],
        demoteIds: []
      })
    };

    jest.spyOn(model, "invoke").mockResolvedValue(rawFallbackResponse as any);

    const snapshot = await consolidateWorkingMemorySnapshot(testChatJid, true);
    expect(snapshot).toBeDefined();
    expect(snapshot).toContain("PERFIL");
    expect(snapshot).toContain("Campinas");

    await deleteVectorMemory(memId);
  });
});
