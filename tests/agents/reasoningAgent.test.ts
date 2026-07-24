import { HumanMessage } from "@langchain/core/messages";
import { reasoningAgentNode } from "../../src/agents/reasoningAgent.js";

describe("Reasoning Agent Node", () => {
  test("deve responder a um dilema ou problema lógico complexo e encerrar com FINISH", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Analise o seguinte dilema: é melhor focar em velocidade de lançamento ou qualidade arquitetural total em uma startup de fase inicial?")],
      contextData: { chatJid: "test-chat@s.whatsapp.net", isTrustedChat: true }
    };

    const result = await reasoningAgentNode(initialState, { configurable: { thread_id: "test-thread" } });

    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("FINISH");
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.contextData.newExecution).toBe("reasoningAgent");
  }, 30000);
});
