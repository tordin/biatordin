import { BaseMessage, SystemMessage } from "@langchain/core/messages";
import { modelFlash as model } from "../llm/model.js";
import { sanitizeMessagesForModel } from "./sanitize.js";
import { logger } from "./logger.js";

export const HARDCODED_CONNECTION_ERROR_MSG =
  "Desculpe, estou com uma instabilidade temporária na minha conexão agora. Pode me tentar chamar em alguns instantes? 🔌";

export interface DynamicErrorParams {
  messages?: BaseMessage[];
  problemDescription: string;
  userGuidance?: string;
}

export async function generateDynamicErrorResponse(params: DynamicErrorParams): Promise<string> {
  const { messages = [], problemDescription, userGuidance } = params;

  try {
    const systemPrompt = new SystemMessage(
      "Você é a Bia, uma assistente virtual amigável, atenciosa e feminina no WhatsApp.\n" +
      "Ocorreu uma situação técnica interna ao tentar processar a solicitação do usuário.\n\n" +
      `SITUAÇÃO INTERNA: ${problemDescription}\n` +
      (userGuidance ? `ORIENTAÇÃO ADICIONAL: ${userGuidance}\n` : "") +
      "\n" +
      "SUA TAREFA:\n" +
      "- Redija uma resposta em tom conversacional, empático e natural (como uma pessoa real no WhatsApp).\n" +
      "- Explique de forma simples e sem termos técnicos excessivos o que aconteceu ou peça para o usuário tentar novamente ou reformular.\n" +
      "- NUNCA diga 'ocorreu uma exceção' ou termos de programação. Mantenha a persona da Bia (feminino, carinhosa, eficiente).\n" +
      "- Responda APENAS com o texto da mensagem para o usuário, sem aspas adicionais ou formatação markdown estruturada."
    );

    const cleanHistory = sanitizeMessagesForModel(messages).slice(-6);
    const messagesForModel = [systemPrompt, ...cleanHistory];

    const response = await model.invoke(messagesForModel);
    const content = typeof response.content === "string" ? response.content.trim() : "";

    if (content) {
      return content;
    }
    return HARDCODED_CONNECTION_ERROR_MSG;
  } catch (err: any) {
    logger.error("[DYNAMIC_ERROR_RESPONSE] Falha na conexão com LLM ao gerar resposta de erro:", err.message || err);
    return HARDCODED_CONNECTION_ERROR_MSG;
  }
}
