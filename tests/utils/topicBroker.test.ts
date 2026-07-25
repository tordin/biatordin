import { resolveTopicForMessage } from "../../src/utils/topicBroker.js";

describe("Topic Broker Classification", () => {
  const testChatJid = "test-topic-broker@s.whatsapp.net";

  test("deve resolver assunto para nova mensagem sem conversas prévias", async () => {
    const result = await resolveTopicForMessage(testChatJid, "Olá Bia, como você está?");
    expect(result).toBeDefined();
    expect(result.topicId).toBeDefined();
    expect(result.title).toBeDefined();
  });
});
