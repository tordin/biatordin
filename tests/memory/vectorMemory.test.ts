import { jest, describe, test, expect, beforeAll } from '@jest/globals';
import { setAIClient } from "../../src/memory/embeddings.js";
import { 
  initVectorMemory, 
  addVectorMemory, 
  searchVectorMemory, 
  deleteVectorMemory, 
  listVectorMemories,
  searchEntityMemory,
  getMemoriesByTopicId,
  syncCoreMemoryToVector
} from "../../src/memory/vectorMemory.js";

describe("Semantic Search RAG Vector Memory Layer (sqlite-vec)", () => {
  const testChatJid = "test-rag-chat@s.whatsapp.net";
  const topicId = "topic-test-rag-123";
  let insertedId1: number;
  let insertedId2: number;

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

  test("deve armazenar anotações no banco vetorial SQLite com topicId em metadata", async () => {
    insertedId1 = await addVectorMemory(
      "Combinei de dar um relógio smartwatch de presente no aniversário do meu irmão em maio",
      "combinado",
      testChatJid,
      { tag: "aniversario", topicId }
    );
    expect(insertedId1).toBeGreaterThan(0);

    insertedId2 = await addVectorMemory(
      "A marca da ração do cachorro anotada é Royal Canin High Digest",
      "compra",
      testChatJid,
      { tag: "pet", topicId }
    );
    expect(insertedId2).toBeGreaterThan(0);
  }, 15000);

  test("deve buscar memórias associadas a um topicId específico", async () => {
    const topicMemories = await getMemoriesByTopicId(topicId, 10);
    expect(topicMemories.length).toBeGreaterThanOrEqual(1);
    expect(topicMemories.some(m => m.id === insertedId1)).toBe(true);
  });

  test("deve buscar compilado amplo por palavras-chave (searchEntityMemory)", async () => {
    const records = await searchEntityMemory(["aniversário", "smartwatch"], testChatJid);
    expect(records).toBeDefined();
    expect(records.length).toBeGreaterThan(0);
    expect(records.some(r => r.content.includes("smartwatch"))).toBe(true);
  });

  test("deve realizar busca semântica RAG por similaridade vetorial", async () => {
    const results = await searchVectorMemory("O que eu combinei sobre o presente do aniversário do meu irmão?", 10, testChatJid, false);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.content.includes("smartwatch"))).toBe(true);
  }, 15000);

  test("deve sincronizar a memória core com o banco vetorial (syncCoreMemoryToVector)", async () => {
    const syncedCount = await syncCoreMemoryToVector();
    expect(typeof syncedCount).toBe("number");
  });


  test("deve excluir memórias do banco relacional e vetorial", async () => {
    const success1 = await deleteVectorMemory(insertedId1);
    const success2 = await deleteVectorMemory(insertedId2);
    expect(success1).toBe(true);
    expect(success2).toBe(true);
  });
});
