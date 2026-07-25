import { HumanMessage } from "@langchain/core/messages";
import { whatsappAgentNode } from "../../src/agents/whatsappAgent.js";

describe("WhatsApp Specialist Agent Node", () => {
  test("deve responder a consultas de mensagens recentes do WhatsApp", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Tem alguma mensagem recente pra mim?")],
      contextData: { 
        chatJid: "5519997064504@s.whatsapp.net", 
        isTrustedChat: true,
        accountName: "main" 
      }
    };

    const result = await whatsappAgentNode(initialState, { configurable: { thread_id: "test-thread-wa" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);
});
