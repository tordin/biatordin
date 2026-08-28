import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { supervisorNode } from "../../src/agents/supervisor.js";
import { recordExecutionEvent, getLastTurnEvents, formatAuditExplanation } from "../../src/utils/executionAudit.js";
import { modelFlash } from "../../src/llm/model.js";

describe("Resilience & Transparency (Self-Healing, Circuit Breaker, /explicar)", () => {
  const testChatJid = "test-resilience@s.whatsapp.net";

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(modelFlash, "invoke").mockResolvedValue(
      new AIMessage("Ocorreu uma instabilidade temporária. Por favor tente novamente em instantes.") as any
    );
  });

  describe("Requisito 2: /explicar & Auditoria de Execução", () => {
    it("deve registrar eventos de execução e gerar mensagem de explicação", () => {
      recordExecutionEvent(testChatJid, {
        toolName: "listRecentChats",
        args: { accountName: "personal" },
        resultSummary: "Encontrada 1 mensagem de Luciana"
      });

      const events = getLastTurnEvents(testChatJid);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].toolName).toBe("listRecentChats");

      const explanation = formatAuditExplanation(events);
      expect(explanation).toContain("Histórico de conversas recentes do WhatsApp");
      expect(explanation).toContain("accountName: personal");
    });
  });

  describe("Requisito 4: Hard Circuit Breaker (Nível 2)", () => {
    it("deve acionar o Circuit Breaker quando totalToolCalls >= 30", async () => {
      const initialState = {
        messages: [new HumanMessage("Bia, pesquise tudo sobre o assunto X"), new AIMessage("Processando...")],
        nextAgent: "supervisor",
        contextData: {
          chatJid: testChatJid,
          totalToolCalls: 30,
          turnStartTime: Date.now(),
          executionLog: [],
        }
      };

      const result = await supervisorNode(initialState as any);
      expect(result.nextAgent).toBe("FINISH");
      
      const lastMsg = result.messages[result.messages.length - 1] as AIMessage;
      expect(typeof lastMsg.content).toBe("string");
      expect((lastMsg.content as string).length).toBeGreaterThan(10);
    }, 30000);

    it("deve acionar o Circuit Breaker quando turnDuration >= 30.000ms", async () => {
      const initialState = {
        messages: [new HumanMessage("Bia, demorei muito para responder"), new AIMessage("Processando...")],
        nextAgent: "supervisor",
        contextData: {
          chatJid: testChatJid,
          totalToolCalls: 1,
          turnStartTime: Date.now() - 125000, // 125 segundos atrás
          executionLog: [],
        }
      };

      const result = await supervisorNode(initialState as any);
      expect(result.nextAgent).toBe("FINISH");
      
      const lastMsg = result.messages[result.messages.length - 1] as AIMessage;
      expect(typeof lastMsg.content).toBe("string");
      expect((lastMsg.content as string).length).toBeGreaterThan(10);
    }, 30000);
  });
});
