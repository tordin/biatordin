import { SystemMessage, AIMessage, RemoveMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "./state.js";
import { modelPro as model } from "../llm/model.js";
import { sanitizeMessagesForModel, buildRecencyAnchoredHistory } from "../utils/sanitize.js";
import { cleanMarkdownForWhatsApp } from "../transport/formatters.js";
import { logger } from "../utils/logger.js";
import { getSkill } from "../skills/registry.js";
import { generateDynamicErrorResponse } from "../utils/dynamicErrorResponse.js";

const REASONING_PROMPT = getSkill("reasoningAgent")?.detailedPrompt || "";

export async function reasoningAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id || "";
  logger.logAgentStart("reasoningAgent", threadId, state.contextData);
  
  try {
    const systemPrompt = `${REASONING_PROMPT}\n\n[DATA E HORA ATUAL]: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;
    const systemMessage = new SystemMessage(systemPrompt);
    const cleanHistory = state.messages.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
    const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);
    
    // Utiliza modelPro (ChatDeepSeek com Thinking Mode ativado, budget_tokens: 8192)
    // Sem tools vinculadas, permitindo que o Thinking Mode funcione perfeitamente sem erros de incompatibilidade de API.
    const response = await model.invoke(
      [systemMessage, ...buildRecencyAnchoredHistory(sanitizedHistory, 12)],
      { metadata: { agentName: "reasoningAgent", threadId } }
    );
    
    if (typeof response.content === "string") {
      response.content = cleanMarkdownForWhatsApp(response.content);
    }
    
    return {
      messages: [response],
      nextAgent: "FINISH",
      contextData: { newExecution: "reasoningAgent" }
    };
  } catch (error: any) {
    logger.error("[REASONING AGENT ERROR]", error.message || error);
    const dynamicMsg = await generateDynamicErrorResponse({
      messages: state.messages,
      problemDescription: `Falha ao processar raciocínio complexo: ${error.message || 'erro desconhecido'}`
    });
    return {
      messages: [new AIMessage(dynamicMsg)],
      nextAgent: "FINISH",
      contextData: { newExecution: "reasoningAgent" }
    };
  }
}
