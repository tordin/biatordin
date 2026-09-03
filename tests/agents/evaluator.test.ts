import { jest, describe, test, it, expect, beforeEach } from "@jest/globals";
import { HumanMessage, AIMessage, ToolMessage, RemoveMessage } from "@langchain/core/messages";
import { evaluatorNode, buildFinalMessages, MAX_EVALUATION_CYCLES, EvaluationSchema } from "../../src/agents/evaluator.js";
import { modelEvaluator } from "../../src/llm/model.js";
import * as dynamicErrorModule from "../../src/utils/dynamicErrorResponse.js";
import { modelFlash } from "../../src/llm/model.js";

// Mock the LLM call for structure output
jest.mock("../../src/utils/structuredOutput.js");

describe("Evaluator / Critic Node & Quality Control", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(modelFlash, "invoke").mockResolvedValue({ content: "Erro dinâmico gerado pelo LLM fake" } as any);
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
      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
      expect((result as any).contextData?.evaluationFeedback).toBeUndefined();
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
      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
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
      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
      expect((result as any).contextData?.evaluationFeedback).toBeUndefined();
    });
  });

  describe("Circuit Breaker / Loop Protection", () => {
    test("deve forçar rotear para outputGateway e injetar erro quando atingir o limite máximo de tentativas", async () => {
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
      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
      expect((result as any).contextData?.evaluationFeedback).toBeUndefined();
      
      const lastMsg = (result as any).messages![(result as any).messages!.length - 1] as AIMessage;
      expect(lastMsg.content).toContain("Erro dinâmico gerado");
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

      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
      expect((result as any).contextData?.evaluationFeedback).toBeUndefined();
      expect((result as any).messages).toBeDefined();
      expect((result as any).messages!.length).toBeGreaterThan(0);
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

      expect((result as any).nextAgent).toBe("supervisor");
      expect((result as any).contextData?.evaluationAttempts).toBe(1);
      expect((result as any).contextData?.evaluationFeedback).toContain("Você não chamou o calendarAgent");
    });

    test("deve aprovar (PASS) quando agente de ação/criação (ex: routineAgent) executa create_routine com sucesso", async () => {
      const mockEvaluation = {
        verdict: "PASS",
        reasoning: "O routineAgent executou a ferramenta create_routine com sucesso e a resposta resume com precisão a criação da rotina de monitoramento.",
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
          new HumanMessage({ content: "Monitore o preço do ACC toda quinta de manhã", id: "msg-h" }),
          new AIMessage({
            content: '<specialist_return agent="routineAgent">\n<collected_data>\nRotina criada com sucesso! ID: 533. Cron: 0 9 * * 4. Prompt: "Monitore o preço do jogo Assetto Corsa..."\n</collected_data>\n</specialist_return>',
            id: "msg-spec"
          })
        ],
        contextData: {
          accountName: "main",
          chatJid: "5519997064504@s.whatsapp.net",
          isTrustedChat: true,
          proposedResponse: "Prontinho, Luiz! Criei a rotina de monitoramento do ACC toda quinta às 9h.",
          executedTools: ["create_routine"],
          executionLog: ["routineAgent"],
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-eval-routine-pass" } });

      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
      expect((result as any).contextData?.evaluationFeedback).toBeUndefined();
      expect((result as any).messages).toBeDefined();
      expect((result as any).messages!.length).toBeGreaterThan(0);
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
      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
    });

    test("deve processar com sucesso payload parcial do avaliador (apenas verdict PASS)", async () => {
      // Simula resposta enxuta omitindo critique, reasoning, feedback e suggestedAction
      const mockPartialEvaluation = {
        verdict: "PASS"
      };

      jest.spyOn(modelEvaluator, "withStructuredOutput").mockReturnValue({
        invoke: jest.fn<any>().mockResolvedValue(mockPartialEvaluation)
      } as any);

      const state: any = {
        messages: [
          new HumanMessage({ content: "Pesquise sobre X", id: "msg-h" }),
          new AIMessage({ content: '<specialist_return agent="searchAgent"><collected_data>Info</collected_data></specialist_return>', id: "msg-spec" })
        ],
        contextData: {
          accountName: "main",
          chatJid: "5519997064504@s.whatsapp.net",
          isTrustedChat: true,
          proposedResponse: "Aqui está o resultado sobre X.",
          executedTools: ["google_search"],
          executionLog: ["searchAgent"],
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-eval-partial" } });

      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
      expect((result as any).messages).toBeDefined();
    });

    test("deve aprovar (PASS) resposta [SILENT] quando a instrução do usuário/rotina pede silêncio condicional", async () => {
      const mockEvaluation = {
        verdict: "PASS",
        reasoning: "O usuário pediu para verificar o clima e ficar em silêncio se a temperatura máxima fosse alta e sem chuva. O weatherAgent foi executado, confirmou tempo bom (31.5°C) e a resposta proposta [SILENT] respeita fielmente a instrução.",
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
          new HumanMessage({ content: "Consulte o clima. Se o dia estiver ensolarado, não envie nenhuma mensagem (fique em silêncio).", id: "msg-h" }),
          new AIMessage({
            content: '<specialist_return agent="weatherAgent"><collected_data>31.5°C Ensolarado</collected_data></specialist_return>',
            id: "msg-spec"
          })
        ],
        contextData: {
          accountName: "main",
          chatJid: "5519997064504@s.whatsapp.net",
          isTrustedChat: true,
          proposedResponse: "[SILENT]",
          executedTools: ["get_weather"],
          executionLog: ["weatherAgent"],
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-eval-conditional-silence" } });

      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
      expect((result as any).contextData?.evaluationFeedback).toBeUndefined();
    });

    test("deve aprovar (PASS) quando o especialista é executado e constata que o item/rotina não existe", async () => {
      const mockEvaluation = {
        verdict: "PASS",
        reasoning: "O routineAgent foi executado com a ferramenta list_routines e confirmou que a rotina solicitada não existe. A resposta da supervisora informando que não encontrou o item é factual e correta.",
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
          new HumanMessage({ content: "Exclua a rotina do boiler solar", id: "msg-h" }),
          new AIMessage({
            content: '<specialist_return agent="routineAgent"><collected_data>Nenhuma rotina ativa encontrada para "boiler solar".</collected_data></specialist_return>',
            id: "msg-spec"
          })
        ],
        contextData: {
          accountName: "main",
          chatJid: "5519997064504@s.whatsapp.net",
          isTrustedChat: true,
          proposedResponse: "Consultei suas rotinas ativas e não encontrei nenhuma relacionada ao boiler solar para excluir.",
          executedTools: ["list_routines"],
          executionLog: ["routineAgent"],
          evaluationAttempts: 0
        }
      };

      const result = await evaluatorNode(state, { configurable: { thread_id: "test-eval-negative-search" } });

      expect((result as any).nextAgent).toBe("outputGateway");
      expect((result as any).contextData?.evaluationAttempts).toBe(0);
      expect((result as any).contextData?.evaluationFeedback).toBeUndefined();
    });
  });
});

