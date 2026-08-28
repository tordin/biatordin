import { describe, test, expect, beforeAll } from '@jest/globals';
import { getMemory, getMemoryAsync, updateMemory, updateMemoryAsync, getAllSandboxesMemory } from "../../src/memory/coreMemory.js";
import { setAIClient } from "../../src/memory/embeddings.js";
import { initVectorMemory, deleteVectorMemory, listVectorMemories } from "../../src/memory/vectorMemory.js";

describe("Core Memory Layer Bridge", () => {
  const trustedJid = "5519997064504@s.whatsapp.net";
  const untrustedJid = "551988880000@s.whatsapp.net";

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

  test("deve ler a memória síncrona / de fallback", () => {
    const memory = getMemory(trustedJid, true);
    expect(memory).toBeDefined();
    expect(typeof memory).toBe("string");
  });

  test("deve compilar a memória de trabalho assíncrona (getMemoryAsync)", async () => {
    await updateMemoryAsync(trustedJid, true, "Informação de perfil do Luiz gravada para teste", 1.0);
    const asyncMemory = await getMemoryAsync(trustedJid, true);
    expect(asyncMemory).toBeDefined();
    expect(typeof asyncMemory).toBe("string");
    expect(asyncMemory).toContain("Informação de perfil do Luiz");
  });

  test("deve isolar a memória assíncrona para chat não-confiável", async () => {
    await updateMemoryAsync(untrustedJid, false, "Nota privada do chat isolado", 0.8);
    const sandboxMemory = await getMemoryAsync(untrustedJid, false);
    expect(sandboxMemory).toContain("Nota privada do chat isolado");
  });

  test("deve chamar getAllSandboxesMemory", () => {
    const sandboxes = getAllSandboxesMemory();
    expect(sandboxes).toBeDefined();
  });

  test("cleanup de dados de teste", async () => {
    const listUntrusted = await listVectorMemories(100, untrustedJid, false);
    for (const item of listUntrusted) {
      await deleteVectorMemory(item.id);
    }
    const listTrusted = await listVectorMemories(100, trustedJid, true);
    for (const item of listTrusted) {
      if (item.content.includes("gravada para teste")) {
        await deleteVectorMemory(item.id);
      }
    }
  });
});
