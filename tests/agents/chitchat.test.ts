import { HumanMessage } from "@langchain/core/messages";
import { chitchatNode } from "../../src/agents/chitchat.js";

describe("Chitchat Agent Node", () => {
  test("deve responder a uma saudação amigável e encerrar com FINISH", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Oi Bia, tudo bem com você?")],
      contextData: { chatJid: "test-chitchat@s.whatsapp.net", isTrustedChat: true }
    };

    const result = await chitchatNode(initialState, { configurable: { thread_id: "test-thread" } });

    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("FINISH");
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);
});
