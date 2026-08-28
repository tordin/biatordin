import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { safeAgentNode } from "../../src/agents/workspace/base.js";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { modelFlash } from "../../src/llm/model.js";

describe("Base Agent Wrapper (safeAgentNode)", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(modelFlash, "invoke").mockResolvedValue(
      new AIMessage("Ocorreu uma instabilidade técnica no especialista.") as any
    );
  });

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
  });
});
