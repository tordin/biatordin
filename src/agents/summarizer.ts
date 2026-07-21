import { SystemMessage, HumanMessage, RemoveMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "./state.js";
import { modelFlash as model } from "../llm/model.js";
import { sanitizeMessagesForModel } from "../utils/sanitize.js";
import { logger } from "../utils/logger.js";

export async function summarizerNode(state: typeof AgentState.State, config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id || "";
  logger.logAgentStart("summarizer", threadId, state.contextData);

  const existingMessages = state.messages;
  
  // Keep the last N messages intact for immediate context
  const KEEP_MESSAGES = 10;
  const messagesToKeep = existingMessages.slice(-KEEP_MESSAGES);
  
  // Summarize everything else
  const messagesToSummarize = existingMessages.slice(0, -KEEP_MESSAGES);

  logger.info(`[SUMMARIZER] Starting summary of ${messagesToSummarize.length} old messages...`);

  const summaryPrompt = new HumanMessage(
    "Crie um resumo muito curto, direto e objetivo desta conversa até o momento. " +
    "Foque apenas nos fatos importantes, decisões tomadas, datas, locais e nomes mencionados. Nunca omita entidades vitais."
  );

  // Sanitize the history to remove SystemMessage, RemoveMessage, raw tool tags and duplicates before passing to the model
  const cleanHistory = messagesToSummarize.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
  const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);

  const dateTimeMsg = new SystemMessage(`[DATA E HORA ATUAL]: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`);
  const summaryResponse = await model.invoke(
    [dateTimeMsg, ...sanitizedHistory, summaryPrompt],
    { metadata: { agentName: "summarizer", threadId } }
  );
  const summaryText = summaryResponse.content;

  // Reset logic: remove old messages
  const removeMessages = existingMessages
    .filter((msg) => msg.id)
    .map((msg) => new RemoveMessage({ id: msg.id! }));

  const summaryMessage = new SystemMessage(`Contexto resumido da conversa anterior:\n${summaryText}`);

  // Re-create kept messages without IDs so they append neatly after the summary
  const newMessagesToKeep = messagesToKeep.map(msg => {
    if (msg instanceof HumanMessage) return new HumanMessage({ content: msg.content, name: msg.name });
    if (msg instanceof AIMessage) return new AIMessage({ content: msg.content, name: msg.name, tool_calls: msg.tool_calls });
    if (msg instanceof ToolMessage) return new ToolMessage({ content: msg.content, tool_call_id: msg.tool_call_id });
    return new SystemMessage({ content: msg.content });
  });

  return {
    messages: [
      ...removeMessages,
      summaryMessage,
      ...newMessagesToKeep
    ]
  };
}

export function shouldSummarize(state: typeof AgentState.State) {
  const context = state.contextData;
  const lastInteraction = context.lastInteractionTimestamp;
  const now = Date.now();

  // A session is new if there was no previous interaction, or if the last interaction was > 30 minutes ago
  const isNewSession = !lastInteraction || (now - lastInteraction) > 30 * 60 * 1000;

  const historyLength = state.messages.length;

  // During an active session, only summarize if history gets extremely large (e.g. > 100)
  // At the start of a new session, summarize if history is large (e.g. > 40)
  const threshold = isNewSession ? 40 : 100;

  if (historyLength > threshold) {
    logger.info(
      `[ROUTING] ${
        isNewSession ? "New session with large history" : "Active session with extremely long history"
      } (${historyLength} msgs). Summarizing...`
    );
    return "summarizer";
  }

  return "supervisor";
}
