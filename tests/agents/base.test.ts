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

  test("deve injetar HumanMessage com specialistTask para turno conversacional válido no ReAct agent", async () => {
    let passedMessages: any[] = [];
    const successfulAgent = {
      invoke: jest.fn<any>().mockImplementation(async (input: any) => {
        passedMessages = input.messages;
        return {
          messages: [
            ...input.messages,
            new AIMessage("Compromissos do dia: 14h Reunião")
          ]
        };
      })
    };

    const state: any = {
      messages: [new HumanMessage("Veja meus compromissos de hoje")],
      contextData: {
        chatJid: "test-base@s.whatsapp.net",
        specialistTask: "Consultar eventos no Google Calendar para hoje"
      }
    };

    const result = await safeAgentNode(
      "calendarAgent",
      () => successfulAgent,
      state,
      undefined,
      { configurable: { thread_id: "test-thread-base-success" } }
    );

    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(passedMessages.some(m => m instanceof HumanMessage && m.content === "Consultar eventos no Google Calendar para hoje")).toBe(true);
    expect(result.messages[0].content).toContain("<specialist_return agent=\"calendarAgent\">");
  });
});
