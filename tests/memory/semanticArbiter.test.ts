import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { arbitrateMemoryCandidate } from '../../src/memory/semanticArbiter.js';
import { 
  initVectorMemory, 
  addVectorMemory, 
  addVectorMemoryWithReconciliation, 
  listVectorMemories, 
  deleteVectorMemory,
  VectorMemoryRecord 
} from '../../src/memory/vectorMemory.js';
import { setAIClient } from '../../src/memory/embeddings.js';
import { modelFlashStructured as model } from '../../src/llm/model.js';

describe("Semantic Arbiter & Memory Reconciliation", () => {
  const testChatJid = "test-arbiter@s.whatsapp.net";

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

  test("deve retornar inserção direta sem chamar LLM quando não houver candidatos", async () => {
    const spy = jest.spyOn(model, 'withStructuredOutput');
    
    const verdict = await arbitrateMemoryCandidate(
      "Gosto de café espresso sem açúcar",
      "preferencia",
      []
    );

    expect(spy).not.toHaveBeenCalled();
    expect(verdict.shouldInsertNew).toBe(true);
    expect(verdict.decisions).toHaveLength(0);
  });

  test("deve arbitrar contradição direta recomendando DELETE da memória antiga e INSERT da nova", async () => {
    const candidate: VectorMemoryRecord = {
      id: 101,
      content: "Luiz toca piano",
      category: "perfil",
      chatJid: testChatJid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      importance: 1.0,
      accessCount: 1,
      lastAccessedAt: new Date().toISOString(),
      distance: 0.15
    };

    const mockResult = {
      decisions: [{
        candidateId: 101,
        action: 'DELETE',
        updatedContent: null,
        updatedImportance: null,
        reason: 'O usuário declarou expressamente que não toca piano, anulando o fato anterior.'
      }],
      shouldInsertNew: true,
      refinedContent: null
    };

    jest.spyOn(model, 'withStructuredOutput').mockReturnValue({
      invoke: async () => mockResult
    } as any);

    const verdict = await arbitrateMemoryCandidate(
      "Luiz não toca piano, ele toca guitarra",
      "perfil",
      [candidate]
    );

    expect(verdict.shouldInsertNew).toBe(true);
    expect(verdict.decisions).toHaveLength(1);
    expect(verdict.decisions[0].action).toBe('DELETE');
    expect(verdict.decisions[0].candidateId).toBe(101);
  });

  test("deve manter memórias de outros sujeitos (KEEP) mesmo com predicados semelhantes", async () => {
    const candidate: VectorMemoryRecord = {
      id: 102,
      content: "A filha Manuela toca piano",
      category: "perfil",
      chatJid: testChatJid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      importance: 1.0,
      accessCount: 1,
      lastAccessedAt: new Date().toISOString(),
      distance: 0.20
    };

    const mockResult = {
      decisions: [{
        candidateId: 102,
        action: 'KEEP',
        updatedContent: null,
        updatedImportance: null,
        reason: 'Sujeitos diferentes: Manuela toca piano, enquanto Luiz não toca. Fato de Manuela deve ser preservado.'
      }],
      shouldInsertNew: true,
      refinedContent: null
    };

    jest.spyOn(model, 'withStructuredOutput').mockReturnValue({
      invoke: async () => mockResult
    } as any);

    const verdict = await arbitrateMemoryCandidate(
      "Luiz não toca piano",
      "perfil",
      [candidate]
    );

    expect(verdict.shouldInsertNew).toBe(true);
    expect(verdict.decisions[0].action).toBe('KEEP');
  });

  test("deve reconciliar e expurgar fato conflitante no SQLite via addVectorMemoryWithReconciliation", async () => {
    // 1. Cria um fato antigo
    const oldId = await addVectorMemory("Luiz trabalha na Empresa Alpha", "perfil", testChatJid, undefined, 1.0);

    // 2. Mock do árbitro para deletar oldId ao salvar o novo
    const mockResult = {
      decisions: [{
        candidateId: oldId,
        action: 'DELETE',
        updatedContent: null,
        updatedImportance: null,
        reason: 'Mudança de emprego confirmada.'
      }],
      shouldInsertNew: true,
      refinedContent: "Luiz trabalha na Empresa Beta"
    };

    jest.spyOn(model, 'withStructuredOutput').mockReturnValue({
      invoke: async () => mockResult
    } as any);

    const result = await addVectorMemoryWithReconciliation(
      "Luiz não trabalha mais na Alpha, agora trabalha na Beta",
      "perfil",
      testChatJid,
      undefined,
      1.0,
      true
    );

    expect(result.memoryId).toBeDefined();
    expect(result.verdict?.decisions[0].action).toBe('DELETE');

    // 3. Verifica se a memória antiga foi realmente deletada do banco
    const list = await listVectorMemories(50, testChatJid, true);
    const hasOld = list.some(m => m.id === oldId);
    const hasNew = list.some(m => m.id === result.memoryId);

    expect(hasOld).toBe(false);
    expect(hasNew).toBe(true);

    // Limpeza
    if (result.memoryId) {
      await deleteVectorMemory(result.memoryId);
    }
  });

  test("deve processar veredito parcial com campos nulos/omitidos sem erro de validação Zod", async () => {
    const candidate: VectorMemoryRecord = {
      id: 103,
      content: "Fato antigo",
      category: "fato",
      chatJid: testChatJid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      importance: 0.5,
      accessCount: 1,
      lastAccessedAt: new Date().toISOString(),
      distance: 0.1
    };

    const mockPartialResult = {
      decisions: [{
        candidateId: 103,
        action: 'KEEP'
        // updatedContent, updatedImportance, reason omitidos
      }]
      // shouldInsertNew e refinedContent omitidos
    };

    jest.spyOn(model, 'withStructuredOutput').mockReturnValue({
      invoke: async () => mockPartialResult
    } as any);

    const verdict = await arbitrateMemoryCandidate("Novo fato complementar", "fato", [candidate]);
    expect(verdict.shouldInsertNew).toBe(true); // Default true
    expect(verdict.decisions[0].action).toBe("KEEP");
    expect(verdict.decisions[0].updatedContent).toBeNull();
  });
});
