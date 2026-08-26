import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { reasoningAgentNode } from "../../src/agents/reasoningAgent.js";
import { modelPro } from "../../src/llm/model.js";

describe("Reasoning Agent Node", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test("deve responder a um dilema ou problema lógico complexo e encerrar com FINISH", async () => {
    jest.spyOn(modelPro, "invoke").mockResolvedValue(
      new AIMessage("Análise detalhada: o equilíbrio ideal envolve equilibrar velocidade inicial com dívida técnica controlada.") as any
    );

    const initialState: any = {
      messages: [new HumanMessage("Analise o seguinte dilema: é melhor focar em velocidade de lançamento ou qualidade arquitetural total em uma startup de fase inicial?")],
      contextData: { chatJid: "test-chat@s.whatsapp.net", isTrustedChat: true }
    };

    const result = await reasoningAgentNode(initialState, { configurable: { thread_id: "test-thread" } });

    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("FINISH");
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.contextData.newExecution).toBe("reasoningAgent");
  });
});
