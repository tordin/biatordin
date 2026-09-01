import { PlanStep, PlanStepStatus } from "../agents/state.js";
import { logger } from "./logger.js";

/**
 * Normaliza qualquer formato de plano (strings, objetos brutos, nulos)
 * para uma lista fortemente tipada de PlanStep[].
 */
export function normalizePlan(rawPlan: (PlanStep | string | any)[] | null | undefined): PlanStep[] {
  if (!rawPlan || !Array.isArray(rawPlan) || rawPlan.length === 0) {
    return [];
  }

  const normalized: PlanStep[] = [];

  for (const item of rawPlan) {
    if (!item) continue;

    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) continue;

      // Suporta formato "agentName: task description" ou apenas "agentName"
      const colonIndex = trimmed.indexOf(":");
      let agent = trimmed;
      let task = "";

      if (colonIndex !== -1) {
        agent = trimmed.substring(0, colonIndex).trim();
        task = trimmed.substring(colonIndex + 1).trim();
      }

      // "FINISH", "END", "NONE" não são agentes especialistas e não devem ser tratados como etapas pendentes
      if (agent.toUpperCase() === "FINISH" || agent.toUpperCase() === "END" || agent.toUpperCase() === "NONE") {
        continue;
      }

      normalized.push({
        agent,
        task: task || `Executar ${agent}`,
        status: "pending"
      });
    } else if (typeof item === "object") {
      const agent = String(item.agent || item.name || "").trim();
      if (!agent || agent.toUpperCase() === "FINISH" || agent.toUpperCase() === "END" || agent.toUpperCase() === "NONE") continue;

      const task = String(item.task || item.description || item.instruction || `Executar ${agent}`).trim();
      const status: PlanStepStatus = (["pending", "in_progress", "completed", "failed"].includes(item.status))
        ? item.status
        : "pending";

      normalized.push({
        agent,
        task,
        status
      });
    }
  }

  return normalized;
}

/**
 * Atualiza o status do plano com base na execução do especialista anterior.
 * Procura a primeira etapa com o agente executado que estava 'in_progress' ou 'pending'.
 */
export function updatePlanProgress(
  currentPlan: (PlanStep | string)[] | null | undefined,
  lastExecutedAgent?: string,
  lastError?: string
): PlanStep[] {
  const plan = normalizePlan(currentPlan);
  if (plan.length === 0 || !lastExecutedAgent) {
    return plan;
  }

  const updated = [...plan];
  
  // Procura primeiro por uma etapa 'in_progress' do agente
  let targetIndex = updated.findIndex(s => s.agent === lastExecutedAgent && s.status === "in_progress");
  
  // Se não houver in_progress, pega a primeira 'pending' desse agente
  if (targetIndex === -1) {
    targetIndex = updated.findIndex(s => s.agent === lastExecutedAgent && s.status === "pending");
  }

  if (targetIndex !== -1) {
    const isError = lastError && lastError.toLowerCase().includes(lastExecutedAgent.toLowerCase());
    updated[targetIndex] = {
      ...updated[targetIndex],
      status: isError ? "failed" : "completed"
    };
    logger.info(`[PLAN_MANAGER] Etapa ${targetIndex + 1} (${updated[targetIndex].agent}) atualizada para: ${updated[targetIndex].status}`);
  }

  return updated;
}

/**
 * Retorna a próxima etapa pendente que pode ser executada com segurança.
 */
export function getNextPendingStep(
  plan: (PlanStep | string)[] | null | undefined,
  executionLog: string[] = []
): PlanStep | null {
  if (!plan || !Array.isArray(plan) || plan.length === 0) return null;

  for (let i = 0; i < plan.length; i++) {
    const raw = plan[i];
    const step: PlanStep = typeof raw === "string" ? normalizePlan([raw])[0] : raw;
    if (!step) continue;

    if (step.status === "pending") {
      // Verifica se o agente já falhou ou se excedeu execuções
      const agentCalls = executionLog.filter(a => a === step.agent).length;
      if (agentCalls >= 3) {
        logger.warn(`[PLAN_MANAGER] Agente ${step.agent} já executou ${agentCalls} vezes. Marcando etapa como falha para evitar loop.`);
        step.status = "failed";
        if (typeof raw === "object") {
          (raw as PlanStep).status = "failed";
        }
        continue;
      }
      return step;
    }
  }

  return null;
}

/**
 * Formata o estado visual do plano para injeção no prompt da Supervisora.
 */
export function formatPlanForPrompt(plan: (PlanStep | string)[] | null | undefined): string {
  const normalized = normalizePlan(plan);
  if (normalized.length === 0) return "";

  const lines: string[] = ["[PLANO DE EXECUÇÃO ATIVO]:"];

  normalized.forEach((step, index) => {
    let icon = "⏳";
    let statusLabel = "PENDENTE";
    if (step.status === "completed") {
      icon = "✓";
      statusLabel = "CONCLUÍDO";
    } else if (step.status === "failed") {
      icon = "❌";
      statusLabel = "FALHOU";
    } else if (step.status === "in_progress") {
      icon = "🔄";
      statusLabel = "EM ANDAMENTO";
    }

    lines.push(`${icon} [${statusLabel}] Etapa ${index + 1}: ${step.agent} -> ${step.task}`);
  });

  const hasPending = normalized.some(s => s.status === "pending" || s.status === "in_progress");
  const nextPending = normalized.find(s => s.status === "pending");

  if (hasPending && nextPending) {
    lines.push("");
    lines.push(`⚠️ ATENÇÃO - PLAN ENFORCEMENT: Há etapas PENDENTES no plano!`);
    lines.push(`Você NÃO DEVE finalizar (FINISH) agora. Roteie para a próxima etapa pendente ("${nextPending.agent}") e defina o specialistTask com clareza.`);
  } else {
    lines.push("");
    lines.push(`Todas as etapas planejadas foram finalizadas. Formule a resposta final consolidada para o usuário no campo 'response' e defina nextAgent = 'FINISH'.`);
  }

  return lines.join("\n");
}

/**
 * Avalia se uma decisão de FINISH da Supervisora foi prematura e deve ser interceptada.
 */
export function shouldEnforcePlan(
  plan: (PlanStep | string)[] | null | undefined,
  proposedNextAgent: string,
  executionLog: string[] = [],
  lastError?: string
): { shouldEnforce: boolean; nextStep?: PlanStep; reason?: string } {
  // Se a supervisora já decidiu chamar outro especialista, não precisa interceptar
  if (proposedNextAgent !== "FINISH") {
    return { shouldEnforce: false };
  }

  const normalized = normalizePlan(plan);
  if (normalized.length === 0) {
    return { shouldEnforce: false };
  }

  // Trava de segurança anti-loop global
  if (executionLog.length >= 5) {
    return {
      shouldEnforce: false,
      reason: "Limite máximo de execuções (5) atingido neste turno."
    };
  }

  const nextStep = getNextPendingStep(normalized, executionLog);
  if (!nextStep) {
    // Não há mais etapas pendentes viáveis
    return { shouldEnforce: false };
  }

  // Se o agente da etapa pendente acabou de falhar gravemente
  if (lastError && lastError.toLowerCase().includes(nextStep.agent.toLowerCase())) {
    nextStep.status = "failed";
    // Tenta encontrar uma outra etapa pendente diferente
    const alternativeStep = getNextPendingStep(normalized, executionLog);
    if (alternativeStep) {
      return {
        shouldEnforce: true,
        nextStep: alternativeStep,
        reason: `Interceptado FINISH prematuro após falha de ${nextStep.agent}. Roteando para próxima etapa viável: ${alternativeStep.agent}`
      };
    }
    return {
      shouldEnforce: false,
      reason: `Etapas restantes inviabilizadas por falha técnica.`
    };
  }

  return {
    shouldEnforce: true,
    nextStep,
    reason: `Interceptado FINISH prematuro. Executando etapa pendente: ${nextStep.agent} (${nextStep.task})`
  };
}
