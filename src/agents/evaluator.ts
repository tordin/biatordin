import { SystemMessage, HumanMessage, AIMessage, RemoveMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { AgentState } from "./state.js";
import { modelEvaluator as model } from "../llm/model.js";
import { invokeStructuredWithFallback } from "../utils/structuredOutput.js";
import { logger } from "../utils/logger.js";
import { validateResponseConsistency } from "../utils/responseValidator.js";
import { applyToolSeals } from "../utils/toolSeals.js";

export const MAX_EVALUATION_CYCLES = 2;

export const EvaluationSchema = z.object({
  verdict: z.enum(["PASS", "NEEDS_CORRECTION"]).default("PASS").describe(
    "PASS se a resposta proposta atende ao pedido, é factual e fundamentada nas ferramentas executadas. NEEDS_CORRECTION se há omissões reais, falsas afirmações de ferramentas não executadas ou inconsistências graves."
  ),
  reasoning: z.string().nullable().default(null).describe(
    "Auditoria concisa confrontando a solicitação do usuário, as ferramentas e agentes executados, os dados coletados e a resposta proposta."
  ),
  critique: z.object({
    isComplete: z.boolean().nullable().default(null).describe("Se todas as solicitações e perguntas do usuário foram atendidas"),
    isGrounded: z.boolean().nullable().default(null).describe("Se todas as alegações e dados apresentados têm respaldo real nas ferramentas executadas e dados coletados"),
    isPersonaCompliant: z.boolean().nullable().default(null).describe("Se o tom e estilo respeitam a persona Bia (amigável, feminina) e o formato WhatsApp"),
  }).nullable().default(null).describe("Avaliação detalhada dos critérios"),
  feedback: z.string().nullable().default(null).describe(
    "Instrução cirúrgica e acionável para a Supervisora corrigir a falha (obrigatório se verdict for NEEDS_CORRECTION)."
  ),
  suggestedAction: z.enum(["ROUTE_TO_SPECIALIST", "FIX_RESPONSE_TEXT", "PASS"]).nullable().default(null).describe(
    "Ação corretiva sugerida para a Supervisora"
  ),
});

export type EvaluationResult = z.infer<typeof EvaluationSchema>;

const EVALUATOR_SYSTEM_PROMPT = 
  "Você é o Avaliador de Qualidade e Auditor Imparcial (Quality Control Critic) da assistente virtual Bia.\n" +
  "Sua função é realizar uma auditoria rigorosa, objetiva e justa pós-execução antes que a resposta final seja entregue ao WhatsApp.\n\n" +
  "COMO AUDITAR (ATENÇÃO AOS DADOS FORNECIDOS):\n" +
  "1. VERIFICAÇÃO DE EXECUÇÃO REAL:\n" +
  "   - Consulte a lista [AGENTES ESPECIALISTAS EXECUTADOS NESTE TURNO] e [FERRAMENTAS EXECUTADAS NESTE TURNO].\n" +
  "   - Agentes de Ação / Criação / Modificação (ex: 'routineAgent', 'taskAgent', 'calendarAgent', 'gmailAgent', 'sheetsAgent', 'trackerAgent', 'crmAgent', 'securityAgent'):\n" +
  "     Se o agente consta em [AGENTES ESPECIALISTAS EXECUTADOS NESTE TURNO] e a respectiva ferramenta (ex: create_routine, update_routine, add_task, complete_task, create_event, send_email) consta em [FERRAMENTAS EXECUTADAS NESTE TURNO], a ação foi DE FATO executada com sucesso. A resposta confirmando a criação/execução/modificação é 100% CORRETA e DEVE ser aprovada (verdict: 'PASS').\n" +
  "   - Agentes de Consulta / Busca (ex: 'whatsappAgent', 'searchAgent', 'memoryAgent', 'weatherAgent', 'shoppingAgent'):\n" +
  "     Se o especialista consta na lista de agentes/ferramentas executadas e há dados correspondentes em [DADOS COLETADOS NOS BASTIDORES], ele foi de fato executado. NUNCA afirme que o agente não foi chamado se ele estiver listado nessas seções.\n\n" +
  "2. QUANDO REPROVAR (verdict: 'NEEDS_CORRECTION'):\n" +
  "   - Reprove APENAS se:\n" +
  "     A) A resposta afirma ter feito algo (ex: 'agendei na agenda', 'enviei o email', 'criei/alterei a tarefa/rotina') mas o agente necessário (ex: calendarAgent, gmailAgent, taskAgent, routineAgent) NÃO CONSTA na lista [AGENTES ESPECIALISTAS EXECUTADOS NESTE TURNO].\n" +
  "     B) O usuário solicitou uma AÇÃO de modificação, criação ou cancelamento (ex: 'modifique a rotina X', 'crie o evento Y') e a Supervisora apenas respondeu com texto ou consultou a memória passiva sem acionar o agente operacional correspondente. Defina `suggestedAction = 'ROUTE_TO_SPECIALIST'`.\n" +
  "     C) O usuário pediu múltiplas ações distintas (ex: consultar o tempo E criar uma tarefa) e uma das ações foi completamente ignorada sem que o especialista correspondente tenha sido executado.\n" +
  "     D) A resposta contradiz diretamente os dados recuperados em [DADOS COLETADOS NOS BASTIDORES].\n\n" +
  "3. MULTI-CONTAS (main vs personal):\n" +
  "   - A Bia pode buscar dados tanto na conta 'main' quanto na conta 'personal'.\n" +
  "   - Se a resposta da supervisora menciona que o grupo/conversa foi encontrado na conta 'personal', isso é perfeitamente válido e NÃO deve ser motivo de reprovação.\n\n" +
  "4. PERSONA & FORMATO (isPersonaCompliant):\n" +
  "   - Tom conversacional, empático, feminino (Bia) e adequado para WhatsApp.\n" +
  "   - NUNCA chame o usuário de 'Master' ou 'Mestre'.\n\n" +
  "DECISÃO:\n" +
  "- Se tudo estiver correto, factual e completo: verdict = 'PASS'.\n" +
  "- Se houver falha real comprovada: verdict = 'NEEDS_CORRECTION', defina 'suggestedAction' ('ROUTE_TO_SPECIALIST' se faltou chamar um especialista, ou 'FIX_RESPONSE_TEXT' se for ajuste redacional) e forneça 'feedback' cirúrgico para a Supervisora.";

/**
 * Cleanly removes intermediate specialist/internal messages after the last HumanMessage
 * and attaches the finalized AIMessage.
 */
export function buildFinalMessages(
  stateMessages: BaseMessage[],
  finalText: string | undefined,
  executedTools: string[],
  executedAgents: string[]
): BaseMessage[] {
  const messagesToRemove: RemoveMessage[] = [];
  let lastHumanIdx = -1;

  for (let i = stateMessages.length - 1; i >= 0; i--) {
    if (stateMessages[i] instanceof HumanMessage) {
      lastHumanIdx = i;
      break;
    }
  }

  if (lastHumanIdx !== -1) {
    for (let i = lastHumanIdx + 1; i < stateMessages.length; i++) {
      const msg = stateMessages[i];
      if (msg.id) {
        messagesToRemove.push(new RemoveMessage({ id: msg.id }));
      }
    }
  }

  let cleanText = finalText ? finalText.trim() : undefined;
  if (cleanText && cleanText.toUpperCase() !== "[SILENT]") {
    // 1. Deterministic validation check
    const validation = validateResponseConsistency(cleanText, executedAgents);
    if (!validation.isValid && validation.correctedResponse) {
      cleanText = validation.correctedResponse;
    }
    // 2. Apply tool seals
    cleanText = applyToolSeals(cleanText, executedTools, executedAgents);
  }

  return [
    ...messagesToRemove,
    ...(cleanText ? [new AIMessage(cleanText)] : [])
  ];
}

/**
 * Extracts collected data snippets from specialist returns and tool messages.
 */
function extractCollectedData(messages: BaseMessage[]): string {
  const dataSnippets: string[] = [];

  for (const msg of messages) {
    if (msg instanceof AIMessage && typeof msg.content === "string") {
      const match = msg.content.match(/<collected_data>([\s\S]*?)<\/collected_data>/i);
      if (match && match[1]) {
        dataSnippets.push(match[1].trim());
      } else {
        const returnMatch = msg.content.match(/<specialist_return[^>]*>([\s\S]*?)<\/specialist_return>/i);
        if (returnMatch && returnMatch[1]) {
          dataSnippets.push(returnMatch[1].trim());
        }
      }
    } else if (msg instanceof ToolMessage && typeof msg.content === "string") {
      dataSnippets.push(msg.content.trim().slice(0, 1000));
    }
  }

  return dataSnippets.length > 0 ? dataSnippets.join("\n\n---\n\n") : "Nenhum dado externo bruto coletado neste turno.";
}

export async function evaluatorNode(
  state: typeof AgentState.State,
  config?: RunnableConfig
) {
  const threadId = config?.configurable?.thread_id || "";
  const currentContext = { ...state.contextData };
  const currentAttempts = currentContext.evaluationAttempts || 0;
  
  const proposedResponse = currentContext.proposedResponse || 
    (() => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];
        if (msg instanceof AIMessage && typeof msg.content === "string") {
          return msg.content;
        }
      }
      return "";
    })();

  const executedTools: string[] = currentContext.executedTools || [];
  const executedAgents: string[] = currentContext.executionLog || [];

  logger.info(`[EVALUATOR] Iniciando avaliação de qualidade (tentativa ${currentAttempts + 1}/${MAX_EVALUATION_CYCLES})...`);
  logger.logAgentStart("evaluator", threadId, { contextData: currentContext });

  // 1. FAST BYPASS: Casos em que a avaliação LLM é desnecessária ou contraproducente
  const isSilent = !proposedResponse || proposedResponse.trim().toUpperCase() === "[SILENT]";
  const isPassiveAccount = currentContext.accountName === "personal";
  const isTargetChat = (currentContext.activeMissions || []).some((m: any) => m.targetJid === currentContext.chatJid);

  if (isSilent && (isPassiveAccount || !currentContext.isTrustedChat || isTargetChat)) {
    logger.info("[EVALUATOR] Fast bypass: Resposta intencionalmente silenciosa em modo passivo/não-confiável/missão.");
    const finalMessages = buildFinalMessages(state.messages, "[SILENT]", executedTools, executedAgents);
    return {
      messages: finalMessages,
      nextAgent: "outputGateway",
      contextData: {
        ...currentContext,
        evaluationFeedback: undefined,
        evaluationSuggestedAction: undefined,
        proposedResponse: undefined,
        evaluationAttempts: 0,
      }
    };
  }

  // Fast bypass para execuções triviais onde nenhum especialista ou ferramenta foi executado neste turno (ex: "oi bom dia", conversas diretas)
  if (executedTools.length === 0 && executedAgents.length === 0) {
    logger.info("[EVALUATOR] Fast bypass: Nenhuma ferramenta ou agente especialista executado neste turno (resposta direta/trivial).");
    const finalMessages = buildFinalMessages(state.messages, proposedResponse, executedTools, executedAgents);
    return {
      messages: finalMessages,
      nextAgent: "outputGateway",
      contextData: {
        ...currentContext,
        evaluationFeedback: undefined,
        evaluationSuggestedAction: undefined,
        proposedResponse: undefined,
        evaluationAttempts: 0,
      }
    };
  }

  // 2. CIRCUIT BREAKER / LOOP PROTECTION: Limite estrito de ciclos de autocorreção
  if (currentAttempts >= MAX_EVALUATION_CYCLES) {
    logger.warn(
      `[EVALUATOR] Limite máximo de ciclos de autocorreção (${MAX_EVALUATION_CYCLES}) atingido. Forçando PASS com sanitização determinística.`
    );
    const finalMessages = buildFinalMessages(state.messages, proposedResponse, executedTools, executedAgents);
    return {
      messages: finalMessages,
      nextAgent: "outputGateway",
      contextData: {
        ...currentContext,
        evaluationFeedback: undefined,
        evaluationSuggestedAction: undefined,
        proposedResponse: undefined,
        evaluationAttempts: 0,
      }
    };
  }

  // 3. Montar contexto de inspeção imparcial
  let latestUserMessage = "";
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i] instanceof HumanMessage) {
      latestUserMessage = typeof state.messages[i].content === "string" 
        ? (state.messages[i].content as string) 
        : JSON.stringify(state.messages[i].content);
      break;
    }
  }

  const collectedData = extractCollectedData(state.messages);

  const auditPrompt = new SystemMessage(
    EVALUATOR_SYSTEM_PROMPT + "\n\n" +
    "[DADOS DO TURNO ATUAL PARA AUDITORIA]:\n" +
    `- SOLICITAÇÃO ORIGINAL DO USUÁRIO:\n"${latestUserMessage}"\n\n` +
    `- FERRAMENTAS EXECUTADAS NESTE TURNO:\n${JSON.stringify(executedTools)}\n\n` +
    `- AGENTES ESPECIALISTAS EXECUTADOS NESTE TURNO:\n${JSON.stringify(executedAgents)}\n\n` +
    `- DADOS COLETADOS NOS BASTIDORES:\n${collectedData}\n\n` +
    `- RESPOSTA FINAL PROPOSTA PELA SUPERVISORA:\n"${proposedResponse}"\n\n` +
    `- CONTEXTO DA CONVERSA:\n` +
    `  • Conta: ${currentContext.accountName || "main"}\n` +
    `  • Chat Confiável: ${!!currentContext.isTrustedChat}\n` +
    `  • É Grupo: ${!!currentContext.isGroup}\n` +
    `  • Nome do Usuário: ${currentContext.senderName || "desconhecido"}`
  );

  try {
    const parsed: EvaluationResult = await invokeStructuredWithFallback(
      model,
      EvaluationSchema,
      [auditPrompt],
      {
        name: "EvaluatorAudit",
        metadata: { agentName: "evaluator", threadId }
      }
    );

    logger.info(`[EVALUATOR] Resultado da auditoria: ${parsed.verdict}. Motivo: ${parsed.reasoning}`);
    logger.logAgentDecision("evaluator", threadId, { verdict: parsed.verdict, reasoning: parsed.reasoning, feedback: parsed.feedback, nextAgent: parsed.verdict === "PASS" ? "outputGateway" : "supervisor" });

    if (parsed.verdict === "PASS") {
      const finalMessages = buildFinalMessages(state.messages, proposedResponse, executedTools, executedAgents);
      return {
        messages: finalMessages,
        nextAgent: "outputGateway",
        contextData: {
          ...currentContext,
          evaluationFeedback: undefined,
          evaluationSuggestedAction: undefined,
          proposedResponse: undefined,
          evaluationAttempts: 0,
        }
      };
    }

    // Caso de falha / NEEDS_CORRECTION:
    logger.warn(`[EVALUATOR] Resposta REPROVADA. Feedback para a supervisora: "${parsed.feedback}" (Ação sugerida: ${parsed.suggestedAction || 'N/A'})`);
    return {
      nextAgent: "supervisor",
      contextData: {
        ...currentContext,
        evaluationAttempts: currentAttempts + 1,
        evaluationFeedback: parsed.feedback || parsed.reasoning,
        evaluationSuggestedAction: parsed.suggestedAction || undefined,
        proposedResponse: undefined,
      }
    };

  } catch (err: any) {
    logger.error("[EVALUATOR] Falha técnica ao executar avaliação estruturada. Prosseguindo com sanitização padrão.", err);
    // Em caso de falha no próprio modelo do avaliador, não trava a execução
    const finalMessages = buildFinalMessages(state.messages, proposedResponse, executedTools, executedAgents);
    return {
      messages: finalMessages,
      nextAgent: "outputGateway",
      contextData: {
        ...currentContext,
        evaluationFeedback: undefined,
        evaluationSuggestedAction: undefined,
        proposedResponse: undefined,
        evaluationAttempts: 0,
      }
    };
  }
}
