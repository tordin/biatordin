import { HumanMessage } from "@langchain/core/messages";
import { weatherAgentNode } from "../../src/agents/weatherAgent.js";

describe("Weather Agent Node", () => {
  test("deve responder sobre a previsão do tempo para uma cidade e encerrar com FINISH", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Como está o tempo em Campinas hoje?")],
      contextData: { chatJid: "test-weather@s.whatsapp.net", isTrustedChat: true }
    };

    const result = await weatherAgentNode(initialState, { configurable: { thread_id: "test-thread" } });

    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);
});
