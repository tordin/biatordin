import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { weatherAgentNode, weatherAgent } from "../../src/agents/weatherAgent.js";

describe("Weather Agent Node", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test("deve responder sobre a previsão do tempo para uma cidade e retornar para supervisor", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Como está o tempo em Campinas hoje?")],
      contextData: { chatJid: "test-weather@s.whatsapp.net", isTrustedChat: true }
    };

    jest.spyOn(weatherAgent, "invoke").mockImplementation(async (input: any) => ({
      messages: [...input.messages, new AIMessage("O clima em Campinas está ensolarado com 26°C.")]
    } as any));

    const result = await weatherAgentNode(initialState, { configurable: { thread_id: "test-thread" } });

    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
