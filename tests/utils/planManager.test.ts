import {
  normalizePlan,
  updatePlanProgress,
  getNextPendingStep,
  formatPlanForPrompt,
  shouldEnforcePlan
} from "../../src/utils/planManager.js";
import { PlanStep } from "../../src/agents/state.js";

describe("Plan Manager Unit Tests", () => {
  describe("normalizePlan", () => {
    test("deve retornar array vazio para entradas nulas ou vazias", () => {
      expect(normalizePlan(null)).toEqual([]);
      expect(normalizePlan(undefined)).toEqual([]);
      expect(normalizePlan([])).toEqual([]);
    });

    test("deve normalizar array de strings simples", () => {
      const raw = ["taskAgent", "calendarAgent"];
      const result = normalizePlan(raw);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ targetAgent: "taskAgent", description: "Executar taskAgent", status: "pending" });
      expect(result[1]).toEqual({ targetAgent: "calendarAgent", description: "Executar calendarAgent", status: "pending" });
    });

    test("deve normalizar array de strings com separador 'agente: tarefa'", () => {
      const raw = ["taskAgent: Adicionar tarefa de comprar café", "calendarAgent: Agendar reunião amanhã"];
      const result = normalizePlan(raw);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        targetAgent: "taskAgent",
        description: "Adicionar tarefa de comprar café",
        status: "pending"
      });
      expect(result[1]).toEqual({
        targetAgent: "calendarAgent",
        description: "Agendar reunião amanhã",
        status: "pending"
      });
    });

    test("deve normalizar array de objetos estruturados", () => {
      const raw = [
        { targetAgent: "taskAgent", description: "Adicionar tarefa de compras", status: "in_progress" },
        { targetAgent: "searchAgent", description: "Buscar receita de bolo", status: "pending" }
      ];
      const result = normalizePlan(raw);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        targetAgent: "taskAgent",
        description: "Adicionar tarefa de compras",
        status: "in_progress"
      });
      expect(result[1]).toEqual({
        targetAgent: "searchAgent",
        description: "Buscar receita de bolo",
        status: "pending"
      });
    });

    test("deve ignorar 'FINISH', 'END' e 'NONE' para não transformá-los em etapas pendentes", () => {
      const raw = ["FINISH"];
      const result = normalizePlan(raw);
      expect(result).toHaveLength(0);

      const mixed = ["taskAgent", "FINISH", { targetAgent: "END", status: "pending" }];
      const mixedResult = normalizePlan(mixed);
      expect(mixedResult).toHaveLength(1);
      expect(mixedResult[0].targetAgent).toBe("taskAgent");
    });
  });

  describe("updatePlanProgress", () => {
    test("deve atualizar etapa correspondente para completed quando execução foi bem sucedida", () => {
      const initialPlan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Criar tarefa", status: "in_progress" },
        { targetAgent: "calendarAgent", description: "Marcar compromisso", status: "pending" }
      ];

      const updated = updatePlanProgress(initialPlan, "taskAgent");
      expect(updated[0].status).toBe("completed");
      expect(updated[1].status).toBe("pending");
    });

    test("deve atualizar etapa para failed quando houver lastError correspondente", () => {
      const initialPlan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Criar tarefa", status: "pending" },
        { targetAgent: "calendarAgent", description: "Marcar compromisso", status: "pending" }
      ];

      const updated = updatePlanProgress(initialPlan, "taskAgent", "taskAgent: Database connection timeout");
      expect(updated[0].status).toBe("failed");
      expect(updated[1].status).toBe("pending");
    });

    test("deve atualizar sequencialmente etapas do mesmo agente se houver mais de uma", () => {
      const initialPlan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Criar tarefa 1", status: "completed" },
        { targetAgent: "taskAgent", description: "Criar tarefa 2", status: "pending" }
      ];

      const updated = updatePlanProgress(initialPlan, "taskAgent");
      expect(updated[0].status).toBe("completed");
      expect(updated[1].status).toBe("completed");
    });
  });

  describe("getNextPendingStep", () => {
    test("deve retornar o primeiro passo pendente", () => {
      const plan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Criar tarefa", status: "completed" },
        { targetAgent: "calendarAgent", description: "Marcar compromisso", status: "pending" }
      ];

      const next = getNextPendingStep(plan);
      expect(next).toBeDefined();
      expect(next?.targetAgent).toBe("calendarAgent");
    });

    test("deve retornar null se todas as etapas estiverem completas ou falhadas", () => {
      const plan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Criar tarefa", status: "completed" },
        { targetAgent: "calendarAgent", description: "Marcar compromisso", status: "failed" }
      ];

      expect(getNextPendingStep(plan)).toBeNull();
    });

    test("deve marcar como falha e pular agente que excedeu limite de chamadas (anti-loop)", () => {
      const plan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Criar tarefa", status: "pending" },
        { targetAgent: "calendarAgent", description: "Marcar compromisso", status: "pending" }
      ];

      // taskAgent já executou 3 vezes no histórico do turno
      const next = getNextPendingStep(plan, ["taskAgent", "taskAgent", "taskAgent"]);
      expect(next).toBeDefined();
      expect(next?.targetAgent).toBe("calendarAgent");
      expect(plan[0].status).toBe("failed");
    });
  });

  describe("formatPlanForPrompt", () => {
    test("deve retornar string vazia para plano vazio", () => {
      expect(formatPlanForPrompt([])).toBe("");
      expect(formatPlanForPrompt(null)).toBe("");
    });

    test("deve formatar plano com etapas concluídas e pendentes e alertar sobre pendências", () => {
      const plan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Criar tarefa de compras", status: "completed" },
        { targetAgent: "calendarAgent", description: "Agendar reunião", status: "pending" }
      ];

      const output = formatPlanForPrompt(plan);
      expect(output).toContain("[PLANO DE EXECUÇÃO ATIVO]:");
      expect(output).toContain("✓ [CONCLUÍDO] Etapa 1: taskAgent -> Criar tarefa de compras");
      expect(output).toContain("⏳ [PENDENTE] Etapa 2: calendarAgent -> Agendar reunião");
      expect(output).toContain("⚠️ ATENÇÃO - PLAN ENFORCEMENT: Há etapas PENDENTES no plano!");
      expect(output).toContain('Roteie para a próxima etapa pendente ("calendarAgent")');
    });

    test("deve informar que todas as etapas foram finalizadas quando não houver pendências", () => {
      const plan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Criar tarefa de compras", status: "completed" },
        { targetAgent: "calendarAgent", description: "Agendar reunião", status: "completed" }
      ];

      const output = formatPlanForPrompt(plan);
      expect(output).toContain("Todas as etapas planejadas foram finalizadas.");
      expect(output).toContain("nextAgent = 'FINISH'");
    });
  });

  describe("shouldEnforcePlan", () => {
    test("não deve interceptar se proposedNextAgent já for um especialista", () => {
      const plan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Criar tarefa", status: "completed" },
        { targetAgent: "calendarAgent", description: "Agendar", status: "pending" }
      ];

      const result = shouldEnforcePlan(plan, "calendarAgent");
      expect(result.shouldEnforce).toBe(false);
    });

    test("não deve interceptar se o plano estiver vazio", () => {
      const result = shouldEnforcePlan([], "FINISH");
      expect(result.shouldEnforce).toBe(false);
    });

    test("não deve interceptar se o plano contiver apenas 'FINISH'", () => {
      const result = shouldEnforcePlan(["FINISH"], "FINISH");
      expect(result.shouldEnforce).toBe(false);
    });

    test("deve interceptar tentativa de FINISH quando houver etapa pendente", () => {
      const plan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Adicionar tarefa", status: "completed" },
        { targetAgent: "calendarAgent", description: "Agendar compromisso", status: "pending" }
      ];

      const result = shouldEnforcePlan(plan, "FINISH", ["taskAgent"]);
      expect(result.shouldEnforce).toBe(true);
      expect(result.nextStep?.targetAgent).toBe("calendarAgent");
      expect(result.nextStep?.description).toBe("Agendar compromisso");
    });

    test("não deve interceptar se todas as etapas do plano já tiverem sido concluídas", () => {
      const plan: PlanStep[] = [
        { targetAgent: "taskAgent", description: "Adicionar tarefa", status: "completed" },
        { targetAgent: "calendarAgent", description: "Agendar compromisso", status: "completed" }
      ];

      const result = shouldEnforcePlan(plan, "FINISH", ["taskAgent", "calendarAgent"]);
      expect(result.shouldEnforce).toBe(false);
    });

    test("não deve interceptar se o limite global de execuções (5) for atingido (anti-loop)", () => {
      const plan: PlanStep[] = [
        { targetAgent: "calendarAgent", description: "Agendar compromisso", status: "pending" }
      ];

      const result = shouldEnforcePlan(plan, "FINISH", ["a", "b", "c", "d", "e"]);
      expect(result.shouldEnforce).toBe(false);
      expect(result.reason).toContain("Limite máximo de execuções");
    });
  });
});
