import { initVectorMemory, addVectorMemory, searchVectorMemory, deleteVectorMemory, listVectorMemories } from "../../src/memory/vectorMemory.js";

describe("Semantic Search RAG Vector Memory Layer (sqlite-vec)", () => {
  const testChatJid = "test-rag-chat@s.whatsapp.net";
  let insertedId1: number;
  let insertedId2: number;

  beforeAll(async () => {
    await initVectorMemory();
  });

  test("deve armazenar anotações no banco vetorial SQLite", async () => {
    insertedId1 = await addVectorMemory(
      "Combinei de dar um relógio smartwatch de presente no aniversário do meu irmão em maio",
      "combinado",
      testChatJid,
      { tag: "aniversario" }
    );
    expect(insertedId1).toBeGreaterThan(0);

    insertedId2 = await addVectorMemory(
      "A marca da ração do cachorro anotada é Royal Canin High Digest",
      "compra",
      testChatJid,
      { tag: "pet" }
    );
    expect(insertedId2).toBeGreaterThan(0);
  }, 15000);

  test("deve listar memórias recentes gravadas", async () => {
    const list = await listVectorMemories(10);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some(m => m.content.includes("smartwatch"))).toBe(true);
    expect(list.some(m => m.content.includes("Royal Canin"))).toBe(true);
  });

  test("deve realizar busca semântica RAG por similaridade vetorial para o presente do irmão", async () => {
    const results = await searchVectorMemory("O que eu combinei sobre o presente do aniversário do meu irmão em maio?", 3, testChatJid);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("smartwatch");
    expect(results[0].distance).toBeDefined();
  }, 15000);

  test("deve realizar busca semântica RAG por similaridade vetorial para a marca da ração", async () => {
    const results = await searchVectorMemory("Qual era a marca daquela ração do cachorro anotada há 3 meses?", 3, testChatJid);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("Royal Canin");
    expect(results[0].distance).toBeDefined();
  }, 15000);

  test("deve excluir memórias do banco relacional e vetorial", async () => {
    const success1 = await deleteVectorMemory(insertedId1);
    const success2 = await deleteVectorMemory(insertedId2);
    expect(success1).toBe(true);
    expect(success2).toBe(true);
  });
});
