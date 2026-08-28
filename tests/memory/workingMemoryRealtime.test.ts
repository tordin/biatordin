import { jest, describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { 
  initVectorMemory, 
  addVectorMemory, 
  deleteVectorMemory, 
  listVectorMemories 
} from '../../src/memory/vectorMemory.js';
import { 
  getWorkingMemoryContext, 
  saveWorkingMemorySnapshot, 
  getSnapshotUpdatedAt 
} from '../../src/memory/workingMemory.js';
import { setAIClient } from '../../src/memory/embeddings.js';

describe("Realtime Working Memory Injection", () => {
  const testChatJid = "test-realtime-injection@s.whatsapp.net";
  const createdIds: number[] = [];

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

  afterEach(async () => {
    for (const id of createdIds) {
      await deleteVectorMemory(id);
    }
    createdIds.length = 0;
  });

  test("deve obter a data correta da última consolidação com getSnapshotUpdatedAt", async () => {
    const fakeSnapshot = "# Perfil Consolidado\n- Luiz mora em Campinas.";
    await saveWorkingMemorySnapshot(testChatJid, fakeSnapshot, { source: "test" });

    const updatedAt = await getSnapshotUpdatedAt(testChatJid);
    expect(updatedAt).toBeInstanceOf(Date);
    expect(updatedAt?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("deve injetar imediatamente fatos de perfil (I=1.0) criados após o snapshot", async () => {
    // 1. Cria um snapshot consolidado
    const snapshotText = "# Perfil Consolidado\n- Luiz mora em Campinas.";
    await saveWorkingMemorySnapshot(testChatJid, snapshotText);

    // Pequeno atraso para garantir timestamp posterior ao snapshot
    await new Promise(r => setTimeout(r, 50));

    // 2. Registra uma correção de perfil vital (I = 1.0) APÓS o snapshot
    const newProfileId = await addVectorMemory(
      "Luiz toca guitarra",
      "perfil",
      testChatJid,
      undefined,
      1.0
    );
    createdIds.push(newProfileId);

    // 3. Executa getWorkingMemoryContext
    const context = await getWorkingMemoryContext(testChatJid, false);

    // 4. Deve conter o snapshot e também a nova correção recente
    expect(context).toContain("Perfil Consolidado");
    expect(context).toContain("Contexto & Fatos Recentes");
    expect(context).toContain("Luiz toca guitarra");
  });

  test("não deve duplicar fatos que já constam textualmente no snapshot", async () => {
    const snapshotText = "# Perfil Consolidado\n- Luiz mora em Campinas.";
    await saveWorkingMemorySnapshot(testChatJid, snapshotText);

    await new Promise(r => setTimeout(r, 50));

    // Fato com mesmo texto já presente no snapshot
    const duplicateId = await addVectorMemory(
      "Luiz mora em Campinas.",
      "perfil",
      testChatJid,
      undefined,
      1.0
    );
    createdIds.push(duplicateId);

    const context = await getWorkingMemoryContext(testChatJid, false);
    // Não deve adicionar seção redundante de fatos recentes pois já está no snapshot
    expect(context).not.toContain("## 🔄 Contexto & Fatos Recentes");
  });
});
