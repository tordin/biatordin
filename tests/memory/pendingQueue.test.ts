import { 
  savePendingMessage, 
  clearPendingMessagesForQueue, 
  getAllPendingMessages 
} from "../../src/memory/pendingQueue.js";

describe("Pending Messages Queue DB", () => {
  const queueKey = "main:test-queue-chat@s.whatsapp.net";
  const msgId = "pending-msg-1";

  test("deve salvar uma mensagem na fila de pendências", async () => {
    await savePendingMessage(
      msgId,
      queueKey,
      "main",
      "test-queue-chat@s.whatsapp.net",
      "Olá Bia!",
      "Usuario Teste",
      "user-1@s.whatsapp.net",
      Date.now(),
      { triggerType: "chat" }
    );

    const pending = await getAllPendingMessages();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.some(m => m.id === msgId)).toBe(true);
  });

  test("deve limpar mensagens pendentes por chave de fila", async () => {
    await clearPendingMessagesForQueue(queueKey);
    const pending = await getAllPendingMessages();
    expect(pending.some(m => m.id === msgId)).toBe(false);
  });
});
