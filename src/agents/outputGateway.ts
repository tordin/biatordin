import { AgentState } from "./state.js";
import { sendDirectMessage } from "../transport/whatsapp.js";
import { logger } from "../utils/logger.js";
import { SystemMessage } from "@langchain/core/messages";
import { checkpointer } from "../memory/checkpointer.js";
import { resolveTopicForMessage } from "../utils/topicBroker.js";
import { appendMessageToHistory } from "../memory/chatHistory.js";
import { RunnableConfig } from "@langchain/core/runnables";

export async function outputGatewayNode(state: typeof AgentState.State, config?: RunnableConfig) {
  const outputMessages = state.contextData?.outputMessages || [];
  if (outputMessages.length === 0) {
    return {};
  }

  logger.info(`[OUTPUT GATEWAY] Processando ${outputMessages.length} mensagens agendadas para envio.`);

  const currentChatJid = state.contextData?.chatJid || "";

  for (const outMsg of outputMessages) {
    const { targetJid, message, accountName } = outMsg;
    
    // 1. Envia a mensagem pelo WhatsApp
    try {
        const sent = await sendDirectMessage(accountName, targetJid, message);
        if (!sent) {
            logger.warn(`[OUTPUT GATEWAY] Falha ao enviar mensagem agendada para ${targetJid}`);
            continue;
        }
    } catch (e) {
        logger.error(`[OUTPUT GATEWAY] Erro ao enviar mensagem agendada para ${targetJid}:`, e);
        continue;
    }

    // 2. Anexa a mensagem no LangGraph state
    if (targetJid !== currentChatJid) {
        logger.info(`[OUTPUT GATEWAY] Injetando log no histórico do Target (${targetJid}) out-of-band.`);
        try {
            // Registrar no history estático como fallback/garantia (lido para resumos longos)
            appendMessageToHistory(accountName, targetJid, {
                id: "out-" + Date.now(),
                timestamp: Date.now(),
                sender: accountName === 'personal' ? 'personal' : 'main',
                senderName: "Bia (Automático)",
                content: message,
                isFromMe: true
            });
            
        } catch (e) {
            logger.error(`[OUTPUT GATEWAY] Erro ao tentar injetar no target state:`, e);
        }
    }
  }

  // Limpa as mensagens após processar, e retorna um SystemMessage para a thread atual
  const messagesToAppend = outputMessages.map(outMsg => {
      const isSameChat = outMsg.targetJid === currentChatJid;
      const text = isSameChat 
        ? `[O AGENTE ENVIOU A SEGUINTE MENSAGEM DIRETAMENTE PARA O ALVO]: ${outMsg.message}`
        : `[MENSAGEM ENVIADA DIRETAMENTE PARA O ALVO ${outMsg.targetJid}]: ${outMsg.message}`;
      return new SystemMessage(text);
  });

  return {
    messages: messagesToAppend,
    contextData: {
      __reset: false,
      outputMessages: [] // Limpa a fila
    }
  };
}
