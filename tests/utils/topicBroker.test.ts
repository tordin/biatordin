import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { initTopicsTable } from "../../src/memory/topics.js";
import { resolveTopicForMessage } from "../../src/utils/topicBroker.js";
import { modelFlashStructured } from "../../src/llm/model.js";

describe("Topic Broker Classification", () => {
  const testChatJid = `test-topic-broker-${Date.now()}@s.whatsapp.net`;

  beforeAll(async () => {
    await initTopicsTable();
  });

  beforeEach(() => {
    jest.spyOn(modelFlashStructured, "withStructuredOutput").mockReturnValue({
      invoke: async () => ({
        topicId: "new",
        newTitle: "Conversa Geral",
        reason: "Saudação inicial"
      })
    } as any);
  });

  test("deve resolver assunto para nova mensagem sem conversas prévias", async () => {
    const result = await resolveTopicForMessage(testChatJid, "Olá Bia, como você está?");
    expect(result).toBeDefined();
    expect(result.topicId).toBeDefined();
    expect(result.title).toBeDefined();
  });

  test("deve aceitar resposta parcial omitindo newTitle e reason sem erro de validação Zod", async () => {
    jest.spyOn(modelFlashStructured, "withStructuredOutput").mockReturnValue({
      invoke: async () => ({
        topicId: "new"
        // newTitle e reason omitidos
      })
    } as any);

    const result = await resolveTopicForMessage(testChatJid, "Outro assunto novo");
    expect(result).toBeDefined();
    expect(result.topicId).toBeDefined();
    expect(result.title).toBe("Novo Assunto"); // Fallback quando newTitle for null
  });
});
