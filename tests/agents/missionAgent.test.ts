import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { missionAgentNode, missionAgent } from "../../src/agents/missionAgent.js";

describe("Mission Agent Node & Tool Integrations", () => {
  const testJid = "test-mission-agent@s.whatsapp.net";

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test("deve instanciar o agent e inicializar estado", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Por favor inicie uma missão com 19999999999")],
      contextData: { chatJid: testJid, accountName: 'main' }
    };

    jest.spyOn(missionAgent, "invoke").mockImplementation(async (input: any) => ({
      messages: [...input.messages, new AIMessage("Missão registrada com sucesso.")]
    } as any));

    const result = await missionAgentNode(initialState, { configurable: { thread_id: "test-thread-mission-1" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
