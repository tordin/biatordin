import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { supervisorNode } from "../../src/agents/supervisor.js";
import { PlanStep } from "../../src/agents/state.js";
import { modelSupervisorActive } from "../../src/llm/model.js";

describe("Plan Enforcement Engine & Multi-Step Execution Tests", () => {
  const testChatJid = "5519997064504@s.whatsapp.net";

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("deve interceptar tentativa de FINISH prematuro quando houver etapas pendentes no plano", async () => {
    // Simula Turno 2: taskAgent já foi executado, mas o calendarAgent ainda está pendente.
    // O modelo LLM decide erroneamente FINISH.
    jest.spyOn(modelSupervisorActive, "withStructuredOutput").mockReturnValue({
      invoke: jest.fn<any>().mockResolvedValue({
        plan: [
          { agent: "taskAgent", task: "Adicionar tarefa comprar leite" },
          { agent: "calendarAgent", task: "Agendar reunião com Pedro amanhã às 15h" }
        ],
        nextAgent: "FINISH", // Tentativa prematura de encerrar!
        specialistTask: null,
        reason: "Concluí a tarefa, finalizando.",
        response: "Adicionei a tarefa de comprar leite na sua lista!",
        intermediateMessage: null,
        contextDataUpdate: null
      })
    } as any);

    const state: any = {
      messages: [
        new HumanMessage("Adicione uma tarefa de comprar leite e agende reunião com Pedro amanhã às 15h"),
        new AIMessage(
          `<specialist_return agent="taskAgent">\n` +
          `<collected_data>✅ Tarefa ID 10 criada com sucesso!</collected_data>\n` +
          `<routing_instruction>Próximo passo</routing_instruction>\n` +
          `</specialist_return>`
        )
      ],
      nextAgent: "supervisor",
      contextData: {
        chatJid: testChatJid,
        isTrustedChat: true,
        accountName: "main",
        executionLog: ["taskAgent"],
        activePlan: [
          { agent: "taskAgent", task: "Adicionar tarefa comprar leite", status: "in_progress" },
          { agent: "calendarAgent", task: "Agendar reunião com Pedro amanhã às 15h", status: "pending" }
        ],
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-plan-enforce-1" } });

    // O Plan Enforcement DEVE interceptar e sobrescrever nextAgent para calendarAgent
    expect(result.nextAgent).toBe("calendarAgent");
    expect(result.contextData?.specialistTask).toBe("Agendar reunião com Pedro amanhã às 15h");
    
    // O plano no contextData deve ter a primeira etapa concluída e a segunda in_progress
    const updatedPlan = result.contextData?.activePlan as PlanStep[];
    expect(updatedPlan).toBeDefined();
    expect(updatedPlan[0].status).toBe("completed");
    expect(updatedPlan[1].status).toBe("in_progress");

    // Não deve emitir mensagem final ainda
    expect(result.messages).toBeUndefined();
  });

  it("deve permitir FINISH normalmente quando todas as etapas do plano estiverem concluídas", async () => {
    // Simula Turno 3: taskAgent e calendarAgent já executaram com sucesso.
    jest.spyOn(modelSupervisorActive, "withStructuredOutput").mockReturnValue({
      invoke: jest.fn<any>().mockResolvedValue({
        plan: [
          { agent: "taskAgent", task: "Adicionar tarefa comprar leite" },
          { agent: "calendarAgent", task: "Agendar reunião com Pedro amanhã às 15h" }
        ],
        nextAgent: "FINISH",
        specialistTask: null,
        reason: "Todas as etapas concluídas com sucesso.",
        response: "Prontinho! Adicionei a tarefa na lista e marquei a reunião com Pedro na sua agenda!",
        intermediateMessage: null,
        contextDataUpdate: null
      })
    } as any);

    const state: any = {
      messages: [
        new HumanMessage("Adicione uma tarefa de comprar leite e agende reunião com Pedro amanhã às 15h"),
        new AIMessage("<specialist_return agent=\"taskAgent\"><collected_data>Tarefa criada</collected_data></specialist_return>"),
        new AIMessage("<specialist_return agent=\"calendarAgent\"><collected_data>Evento agendado</collected_data></specialist_return>")
      ],
      nextAgent: "supervisor",
      contextData: {
        chatJid: testChatJid,
        isTrustedChat: true,
        accountName: "main",
        executionLog: ["taskAgent", "calendarAgent"],
        activePlan: [
          { agent: "taskAgent", task: "Adicionar tarefa comprar leite", status: "completed" },
          { agent: "calendarAgent", task: "Agendar reunião com Pedro amanhã às 15h", status: "in_progress" }
        ],
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-plan-enforce-2" } });

    // Permite FINISH normalmente
    expect(result.nextAgent).toBe("FINISH");
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);

    const lastMsg = result.messages[result.messages.length - 1];
    expect((lastMsg.content as string)).toContain("Adicionei a tarefa");
  });

  it("deve tratar falha em uma etapa e prosseguir para as etapas pendentes subsequentes", async () => {
    // taskAgent falhou, mas ainda temos weatherAgent pendente
    jest.spyOn(modelSupervisorActive, "withStructuredOutput").mockReturnValue({
      invoke: jest.fn<any>().mockResolvedValue({
        plan: [
          { agent: "taskAgent", task: "Criar tarefa" },
          { agent: "weatherAgent", task: "Consultar previsão do tempo" }
        ],
        nextAgent: "FINISH", // LLM tenta desistir cedo devido ao erro
        specialistTask: null,
        reason: "Houve erro na tarefa.",
        response: "Não consegui adicionar a tarefa.",
        intermediateMessage: null,
        contextDataUpdate: null
      })
    } as any);

    const state: any = {
      messages: [
        new HumanMessage("Crie uma tarefa de teste e me dê a previsão do tempo"),
        new AIMessage("<specialist_return agent=\"taskAgent\" status=\"error\"><error_details>Database locked</error_details></specialist_return>")
      ],
      nextAgent: "supervisor",
      contextData: {
        chatJid: testChatJid,
        isTrustedChat: true,
        accountName: "main",
        lastError: "taskAgent: Database locked",
        executionLog: ["taskAgent"],
        activePlan: [
          { agent: "taskAgent", task: "Criar tarefa", status: "in_progress" },
          { agent: "weatherAgent", task: "Consultar previsão do tempo", status: "pending" }
        ],
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-plan-enforce-error-recovery" } });

    // Deve atualizar taskAgent para 'failed' e avançar para weatherAgent
    expect(result.nextAgent).toBe("weatherAgent");
    const plan = result.contextData?.activePlan as PlanStep[];
    expect(plan[0].status).toBe("failed");
    expect(plan[1].status).toBe("in_progress");
  });

  it("deve respeitar limites de anti-loop e não entrar em loop infinito mesmo com etapas pendentes", async () => {
    // 5 execuções já realizadas no turno
    jest.spyOn(modelSupervisorActive, "withStructuredOutput").mockReturnValue({
      invoke: jest.fn<any>().mockResolvedValue({
        plan: [
          { agent: "taskAgent", task: "Criar tarefa" },
          { agent: "calendarAgent", task: "Agendar" },
          { agent: "gmailAgent", task: "Enviar email" }
        ],
        nextAgent: "FINISH",
        specialistTask: null,
        reason: "Limite atingido.",
        response: "Finalizando execução.",
        intermediateMessage: null,
        contextDataUpdate: null
      })
    } as any);

    const state: any = {
      messages: [
        new HumanMessage("Faça muitas coisas"),
        new AIMessage("Processado...")
      ],
      nextAgent: "supervisor",
      contextData: {
        chatJid: testChatJid,
        isTrustedChat: true,
        accountName: "main",
        executionLog: ["taskAgent", "calendarAgent", "searchAgent", "shoppingAgent", "routineAgent"], // 5 execuções
        activePlan: [
          { agent: "gmailAgent", task: "Enviar email", status: "pending" }
        ],
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-plan-enforce-anti-loop" } });

    // Não deve interceptar porque atingiu o limite de 5 execuções
    expect(result.nextAgent).toBe("FINISH");
  });

  it("deve funcionar com planos em formato legado (array de strings)", async () => {
    jest.spyOn(modelSupervisorActive, "withStructuredOutput").mockReturnValue({
      invoke: jest.fn<any>().mockResolvedValue({
        plan: ["taskAgent", "calendarAgent"],
        nextAgent: "FINISH",
        specialistTask: null,
        reason: "Finalizando.",
        response: "Tudo pronto!",
        intermediateMessage: null,
        contextDataUpdate: null
      })
    } as any);

    const state: any = {
      messages: [
        new HumanMessage("Criar tarefa e agendar compromisso"),
        new AIMessage("<specialist_return agent=\"taskAgent\"><collected_data>OK</collected_data></specialist_return>")
      ],
      nextAgent: "supervisor",
      contextData: {
        chatJid: testChatJid,
        isTrustedChat: true,
        accountName: "main",
        executionLog: ["taskAgent"],
        activePlan: ["taskAgent", "calendarAgent"] // Strings legadas
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-plan-enforce-legacy-strings" } });

    // Deve normalizar e interceptar para calendarAgent
    expect(result.nextAgent).toBe("calendarAgent");
    const plan = result.contextData?.activePlan as PlanStep[];
    expect(plan).toBeDefined();
    expect(plan[0].status).toBe("completed");
    expect(plan[1].status).toBe("in_progress");
  });
});
