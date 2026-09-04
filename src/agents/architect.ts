import { RunnableConfig } from "@langchain/core/runnables";
import { AgentState, PlanStep } from "./state.js";
import { googleGenAI } from "../llm/model.js";
import { logger } from "../utils/logger.js";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export async function architectNode(state: typeof AgentState.State, config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id || "";
  logger.info(`[ARCHITECT] Iniciando planejamento para ${threadId}`);

  // Extract text history for Gemini
  const chatHistory = state.messages
    .filter(m => m instanceof HumanMessage || m instanceof SystemMessage)
    .map(m => `${m._getType()}: ${m.content}`)
    .join("\n");

  const schema = {
    type: "ARRAY",
    description: "Lista de passos para cumprir o objetivo complexo do usuário",
    items: {
      type: "OBJECT",
      properties: {
        targetAgent: {
          type: "STRING",
          description: "Nome do especialista alvo. Ex: searchAgent, calendarAgent, gmailAgent, emailSentinelAgent, sheetsAgent, docsAgent, driveAgent, routineAgent, memoryAgent, taskAgent, trackerAgent, securityAgent, shoppingAgent, whatsappAgent, reasoningAgent, weatherAgent, missionAgent, followUpAgent, crmAgent"
        },
        description: {
          type: "STRING",
          description: "Instrução cirúrgica e detalhada para o agente"
        }
      },
      required: ["targetAgent", "description"]
    }
  };

  const response = await googleGenAI.models.generateContent({
    model: "gemini-3.8-flash",
    contents: `Você é o Arquiteto de Fluxos da Bia. Crie um plano passo a passo para o pedido do usuário.\n\nHistórico:\n${chatHistory}`,
    config: {
      temperature: 0.1,
      // @ts-ignore
      thinkingConfig: {
        // @ts-ignore
        thinkingBudgetTokens: 1024
      },
      responseMimeType: "application/json",
      responseSchema: schema as any
    }
  });

  const text = response.text || "[]";
  let parsedPlan: any[] = [];
  try {
    parsedPlan = JSON.parse(text);
  } catch (e) {
    logger.error("[ARCHITECT] Falha ao fazer parse do plano:", e);
  }

  const activePlan: PlanStep[] = parsedPlan.map((p: any) => ({
    targetAgent: p.targetAgent,
    description: p.description,
    status: "pending"
  }));

  return {
    nextAgent: "supervisor",
    contextData: {
      ...state.contextData,
      activePlan,
    }
  };
}
