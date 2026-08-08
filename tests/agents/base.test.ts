import { jest, describe, test, expect } from '@jest/globals';
import { safeAgentNode } from "../../src/agents/workspace/base.js";
import { HumanMessage } from "@langchain/core/messages";

describe("Base Agent Wrapper (safeAgentNode)", () => {
  test("deve capturar erro gracioso e retornar aviso ao exceder limites ou lançar exceção", async () => {
    const failingAgent = {
      invoke: jest.fn<any>().mockRejectedValue(new Error("Erro simulado no especialista"))
    };

    const state: any = {
      messages: [new HumanMessage("Testar falha")],
      contextData: { chatJid: "test-base@s.whatsapp.net" }
    };

    const result = await safeAgentNode(
      "testAgent",
      () => failingAgent,
      state,
      undefined,
      { configurable: { thread_id: "test-thread-base" } }
    );

    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(result.contextData.lastError).toContain("testAgent: Erro simulado no especialista");
  }, 30000);
});
