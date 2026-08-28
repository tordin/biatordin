import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { memoryAgentNode, memoryAgent } from "../../src/agents/memoryAgent.js";

describe("Memory Agent Node & Tool Integrations", () => {
  const testJid = "test-memory-agent@s.whatsapp.net";

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test("deve armazenar um novo fato na memória semântica RAG", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Guarde na memória que o tamanho do calçado da Cecília é 24")],
      contextData: { chatJid: testJid, isTrustedChat: true, active_topic_title: "Festa da Cecília" }
    };

    jest.spyOn(memoryAgent, "invoke").mockImplementation(async (input: any) => ({
      messages: [...input.messages, new AIMessage("Memória armazenada com sucesso!")]
    } as any));

    const result = await memoryAgentNode(initialState, { configurable: { thread_id: "test-thread-mem-1" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test("deve consultar fato semântico usando searchSemanticMemory", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Qual é o tamanho do calçado da Cecília anotado na memória?")],
      contextData: { chatJid: testJid, isTrustedChat: true }
    };

    jest.spyOn(memoryAgent, "invoke").mockImplementation(async (input: any) => ({
      messages: [...input.messages, new AIMessage("O tamanho do calçado da Cecília é 24.")]
    } as any));

    const result = await memoryAgentNode(initialState, { configurable: { thread_id: "test-thread-mem-2" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test("deve fazer busca ampla por entidade usando searchEventSummary", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Me fala tudo sobre o evento Festa da Cecília e o que temos anotado")],
      contextData: { chatJid: testJid, isTrustedChat: true }
    };

    jest.spyOn(memoryAgent, "invoke").mockImplementation(async (input: any) => ({
      messages: [...input.messages, new AIMessage("Aqui está o resumo amplo da Festa da Cecília...")]
    } as any));

    const result = await memoryAgentNode(initialState, { configurable: { thread_id: "test-thread-mem-3" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
