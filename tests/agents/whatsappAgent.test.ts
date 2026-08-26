import { HumanMessage } from "@langchain/core/messages";
import { whatsappAgentNode, generateDailySummaryTool } from "../../src/agents/whatsappAgent.js";

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

  test("generateDailySummaryTool deve aceitar horas e filtro opcional", async () => {
    const resAll = await generateDailySummaryTool.invoke({ hours: 24 });
    expect(typeof resAll).toBe("string");

    const resFilter = await generateDailySummaryTool.invoke({ hours: 24, filter: "iFood" });
    expect(typeof resFilter).toBe("string");
  });
});
