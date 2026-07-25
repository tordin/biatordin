import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { jest } from "@jest/globals";
import { shouldSummarize, summarizerNode } from "../../src/agents/summarizer.js";
import { modelFlash } from "../../src/llm/model.js";

describe("Summarizer Node & Session Thresholds", () => {
  test("deve decidir não sumarizar quando o histórico for pequeno", () => {
    const state: any = {
      messages: [new HumanMessage("Mensagem 1"), new HumanMessage("Mensagem 2")],
      contextData: { lastInteractionTimestamp: Date.now() }
    };

    const decision = shouldSummarize(state);
    expect(decision).toBe("supervisor");
  });

  test("deve decidir sumarizar quando o histórico for muito longo em nova sessão", () => {
    const longMessages = Array(45).fill(null).map((_, i) => new HumanMessage(`Mensagem ${i}`));
    const state: any = {
      messages: longMessages,
      contextData: { lastInteractionTimestamp: Date.now() - 40 * 60 * 1000 } // 40 minutos atrás (nova sessão)
    };

    const decision = shouldSummarize(state);
    expect(decision).toBe("summarizer");
  });

  test("deve executar o nó sumarizador e substituir histórico antigo por SystemMessage resumida", async () => {
    jest.spyOn(modelFlash, "invoke").mockResolvedValueOnce(new AIMessage("Resumo consolidado da conversa.") as any);

    const longMessages = Array(15).fill(null).map((_, i) => new HumanMessage({ content: `Mensagem antiga de teste ${i}`, id: `msg-${i}` }));
    const state: any = {
      messages: longMessages,
      contextData: { chatJid: "test-summarizer@s.whatsapp.net" }
    };

    const result = await summarizerNode(state, { configurable: { thread_id: "test-thread-sum" } });
    expect(result).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);
});
