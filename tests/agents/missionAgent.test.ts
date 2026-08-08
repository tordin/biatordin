import { HumanMessage } from "@langchain/core/messages";
import { missionAgentNode } from "../../src/agents/missionAgent.js";

describe("Mission Agent Node & Tool Integrations", () => {
  const testJid = "test-mission-agent@s.whatsapp.net";

  test("deve instanciar o agent e inicializar estado", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Por favor inicie uma missão com 19999999999")],
      contextData: { chatJid: testJid, accountName: 'main' }
    };

    const result = await missionAgentNode(initialState, { configurable: { thread_id: "test-thread-mission-1" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);
});
