import { HumanMessage } from "@langchain/core/messages";
import { memoryAgentNode } from "../../src/agents/memoryAgent.js";

describe("Memory Agent Node & Tool Integrations", () => {
  const testJid = "test-memory-agent@s.whatsapp.net";

  test("deve armazenar um novo fato na memória semântica RAG", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Guarde na memória que o tamanho do calçado da Cecília é 24")],
      contextData: { chatJid: testJid, isTrustedChat: true, active_topic_title: "Festa da Cecília" }
    };

    const result = await memoryAgentNode(initialState, { configurable: { thread_id: "test-thread-mem-1" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);

  test("deve consultar fato semântico usando searchSemanticMemory", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Qual é o tamanho do calçado da Cecília anotado na memória?")],
      contextData: { chatJid: testJid, isTrustedChat: true }
    };

    const result = await memoryAgentNode(initialState, { configurable: { thread_id: "test-thread-mem-2" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);

  test("deve fazer busca ampla por entidade usando searchEventSummary", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Me fala tudo sobre o evento Festa da Cecília e o que temos anotado")],
      contextData: { chatJid: testJid, isTrustedChat: true }
    };

    const result = await memoryAgentNode(initialState, { configurable: { thread_id: "test-thread-mem-3" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);
});
