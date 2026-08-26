import { jest, describe, test, it, expect, beforeEach } from "@jest/globals";
import { HumanMessage, AIMessage, ToolMessage, RemoveMessage } from "@langchain/core/messages";
import { evaluatorNode, buildFinalMessages, MAX_EVALUATION_CYCLES, EvaluationSchema } from "../../src/agents/evaluator.js";
import { modelEvaluator } from "../../src/llm/model.js";

describe("Evaluator / Critic Node & Quality Control", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe("buildFinalMessages helper", () => {
    test("deve remover mensagens intermediárias de especialistas e anexar AIMessage final", () => {
      const humanMsg = new HumanMessage({ content: "Qual o clima em SP?", id: "msg-1" });
      const specialistMsg = new AIMessage({
        content: '<specialist_return agent="weatherAgent"><collected_data>24°C ensolarado</collected_data></specialist_return>',
        id: "msg-2"
      });
      const stateMessages = [humanMsg, specialistMsg];

      const finalMessages = buildFinalMessages(
        stateMessages,
        "Em São Paulo está fazendo 24°C com céu ensolarado!",
        ["get_weather"],
        ["weatherAgent"]
      );

      // Deve ter 1 RemoveMessage para msg-2 e 1 novo AIMessage
      expect(finalMessages.length).toBe(2);
      expect(finalMessages[0]).toBeInstanceOf(RemoveMessage);
      expect((finalMessages[0] as RemoveMessage).id).toBe("msg-2");
      expect(finalMessages[1]).toBeInstanceOf(AIMessage);
      expect((finalMessages[1] as AIMessage).content).toContain("São Paulo está fazendo 24°C");
    });

    test("deve aplicar validação anti-mentira determinística se a resposta alegar ações não executadas", () => {
      const humanMsg = new HumanMessage({ content: "Pesquise os preços e me envie por email", id: "msg-1" });
      const stateMessages = [humanMsg];

      // Afirma ter enviado e-mail mas gmailAgent não consta em executedAgents
      const finalMessages = buildFinalMessages(
        stateMessages,
        "Pesquisei os preços e enviei o e-mail pra você!",
        ["google_search"],
        ["searchAgent"] // gmailAgent NÃO foi executado
      );

      const lastMsg = finalMessages[finalMessages.length - 1] as AIMessage;
      expect(lastMsg.content).toBeDefined();
      // validateResponseConsistency substitui a falsa afirmação
      expect(lastMsg.content).not.toContain("enviei o e-mail");
    });
  });

  describe("Fast Bypass", () => {
    test("deve aprovar imediatamente (PASS) respostas [SILENT] em conta pessoal (Cenário 3)", async () => {
      const state: any = {
        messages: [new HumanMessage("Conversa pessoal qualquer")],
        contextData: {
          accountName: "personal",
          chatJid: "551999999999@s.whatsapp.net",
          isTrustedChat: false,
          proposedResponse: "[SILENT]",
          executedTools: [],
          executionLog: [],
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-fast-bypass-personal" } });
      expect(result.nextAgent).toBe("outputGateway");
      expect(result.contextData?.evaluationAttempts).toBe(0);
      expect(result.contextData?.evaluationFeedback).toBeUndefined();
    });

    test("deve aprovar imediatamente (PASS) respostas [SILENT] em grupos não-confiáveis quando não chamada", async () => {
      const state: any = {
        messages: [new HumanMessage("Conversa no grupo sem chamar a Bia")],
        contextData: {
          accountName: "main",
          chatJid: "123456789@g.us",
          isGroup: true,
          isTrustedChat: false,
          proposedResponse: "[SILENT]",
          executedTools: [],
          executionLog: [],
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-fast-bypass-group" } });
      expect(result.nextAgent).toBe("outputGateway");
      expect(result.contextData?.evaluationAttempts).toBe(0);
    });

    test("deve ignorar auditoria em execuções triviais (ex: 'oi bom dia') onde nenhum especialista foi chamado", async () => {
      const state: any = {
        messages: [new HumanMessage("Oi Bia, bom dia!")],
        contextData: {
          accountName: "main",
          chatJid: "5519997064504@s.whatsapp.net",
          isTrustedChat: true,
          proposedResponse: "Bom dia, Luiz! Como posso te ajudar hoje?",
          executedTools: [],
          executionLog: [], // Nenhuma ferramenta ou agente chamado
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-trivial-bypass" } });
      expect(result.nextAgent).toBe("outputGateway");
      expect(result.contextData?.evaluationAttempts).toBe(0);
      expect(result.contextData?.evaluationFeedback).toBeUndefined();
    });
  });

  describe("Circuit Breaker / Loop Protection", () => {
    test("deve forçar PASS e rotear para outputGateway quando atingir o limite máximo de tentativas", async () => {
      const state: any = {
        messages: [new HumanMessage("Faça X")],
        contextData: {
          accountName: "main",
          chatJid: "5519997064504@s.whatsapp.net",
          isTrustedChat: true,
          proposedResponse: "Tentativa de resposta",
          executedTools: ["searchAgent"],
          executionLog: ["searchAgent"],
          evaluationAttempts: MAX_EVALUATION_CYCLES // Limite atingido (2)
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-circuit-breaker" } });
      expect(result.nextAgent).toBe("outputGateway");
      expect(result.contextData?.evaluationAttempts).toBe(0);
      expect(result.contextData?.evaluationFeedback).toBeUndefined();
    });
  });

  describe("LLM Decision Auditing & Self-Correction Feedback (GPT-4o-mini)", () => {
    test("deve aprovar (PASS) quando a resposta for factual e completa", async () => {
      const mockEvaluation = {
        verdict: "PASS",
        reasoning: "A consulta de clima foi executada com a ferramenta get_weather e a resposta resume com precisão os dados obtidos.",
        critique: {
          isComplete: true,
          isGrounded: true,
          isPersonaCompliant: true,
        },
        suggestedAction: "PASS",
      };

      jest.spyOn(modelEvaluator, "withStructuredOutput").mockReturnValue({
        invoke: jest.fn<any>().mockResolvedValue(mockEvaluation)
      } as any);

      const state: any = {
        messages: [
          new HumanMessage({ content: "Qual a temperatura em São Paulo?", id: "msg-h" }),
          new AIMessage({
            content: '<specialist_return agent="weatherAgent"><collected_data>22°C</collected_data></specialist_return>',
            id: "msg-spec"
          })
        ],
        contextData: {
          accountName: "main",
          chatJid: "5519997064504@s.whatsapp.net",
          isTrustedChat: true,
          proposedResponse: "A temperatura atual em São Paulo é de 22°C.",
          executedTools: ["get_weather"],
          executionLog: ["weatherAgent"],
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-eval-pass" } });

      expect(result.nextAgent).toBe("outputGateway");
      expect(result.contextData?.evaluationAttempts).toBe(0);
      expect(result.contextData?.evaluationFeedback).toBeUndefined();
      expect(result.messages).toBeDefined();
      expect(result.messages!.length).toBeGreaterThan(0);
    });

    test("deve reprovar (NEEDS_CORRECTION) e retornar feedback para a supervisora quando houver alucinação de ferramenta", async () => {
      const mockEvaluation = {
        verdict: "NEEDS_CORRECTION",
        reasoning: "O usuário pediu para verificar emails e adicionar um compromisso na agenda. A supervisora apenas consultou emails via gmailAgent mas não executou calendarAgent.",
        critique: {
          isComplete: false,
          isGrounded: false,
          isPersonaCompliant: true,
        },
        feedback: "Você não chamou o calendarAgent para criar o evento na agenda. Roteie para o calendarAgent com specialistTask detalhando o evento antes de finalizar.",
        suggestedAction: "ROUTE_TO_SPECIALIST",
      };

      jest.spyOn(modelEvaluator, "withStructuredOutput").mockReturnValue({
        invoke: jest.fn<any>().mockResolvedValue(mockEvaluation)
      } as any);

      const state: any = {
        messages: [
          new HumanMessage({ content: "Veja meus emails e agende uma reunião com o Marcelo amanhã às 15h", id: "msg-h" }),
          new AIMessage({
            content: '<specialist_return agent="gmailAgent"><collected_data>3 emails lidos</collected_data></specialist_return>',
            id: "msg-spec"
          })
        ],
        contextData: {
          accountName: "main",
          chatJid: "5519997064504@s.whatsapp.net",
          isTrustedChat: true,
          proposedResponse: "Verifiquei seus e-mails e a reunião com o Marcelo já está agendada para amanhã às 15h!",
          executedTools: ["list_emails"],
          executionLog: ["gmailAgent"], // calendarAgent não executado!
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-eval-fail" } });

      expect(result.nextAgent).toBe("supervisor");
      expect(result.contextData?.evaluationAttempts).toBe(1);
      expect(result.contextData?.evaluationFeedback).toContain("Você não chamou o calendarAgent");
    });

    test("deve lidar com falhas técnicas no LLM do avaliador sem quebrar a execução", async () => {
      jest.spyOn(modelEvaluator, "withStructuredOutput").mockReturnValue({
        invoke: jest.fn<any>().mockRejectedValue(new Error("LLM API Timeout"))
      } as any);
      jest.spyOn(modelEvaluator, "invoke").mockRejectedValue(new Error("Fallback error"));

      const state: any = {
        messages: [
          new HumanMessage({ content: "Pesquise os voos para o RJ", id: "msg-h" }),
          new AIMessage({
            content: '<specialist_return agent="searchAgent"><collected_data>Voos disponíveis...</collected_data></specialist_return>',
            id: "msg-spec"
          })
        ],
        contextData: {
          accountName: "main",
          chatJid: "5519997064504@s.whatsapp.net",
          isTrustedChat: true,
          proposedResponse: "Encontrei opções de voos para o Rio de Janeiro.",
          executedTools: ["google_search"],
          executionLog: ["searchAgent"],
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-eval-error" } });

      // Em fallback de erro, não bloqueia o fluxo e roteia para outputGateway
      expect(result.nextAgent).toBe("outputGateway");
      expect(result.contextData?.evaluationAttempts).toBe(0);
    });
  });
});
