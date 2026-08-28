import { 
  savePendingMessage, 
  clearPendingMessagesForQueue, 
  getAllPendingMessages,
  clearStalePendingMessages
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

  test("deve limpar mensagens antigas com base no cutoff de horas", async () => {
    const oldMsgId = "pending-msg-old";
    const twoDaysAgo = Date.now() - (48 * 60 * 60 * 1000);
    await savePendingMessage(
      oldMsgId,
      queueKey,
      "main",
      "test-queue-chat@s.whatsapp.net",
      "Mensagem antiga",
      "Usuario Antigo",
      "user-old@s.whatsapp.net",
      twoDaysAgo,
      { triggerType: "chat" }
    );

    const pendingBefore = await getAllPendingMessages();
    expect(pendingBefore.some(m => m.id === oldMsgId)).toBe(true);

    const deletedCount = await clearStalePendingMessages(24);
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    const pendingAfter = await getAllPendingMessages();
    expect(pendingAfter.some(m => m.id === oldMsgId)).toBe(false);
  });
});

