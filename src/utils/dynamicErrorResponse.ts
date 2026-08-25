import { BaseMessage, SystemMessage } from "@langchain/core/messages";
import { modelFlash as model } from "../llm/model.js";
import { logger } from "./logger.js";

export const HARDCODED_CONNECTION_ERROR_MSG =
  "Desculpe, estou com uma instabilidade temporária na minha conexão agora. Pode me tentar chamar em alguns instantes? 🔌";

export interface DynamicErrorParams {
  messages?: BaseMessage[];
  problemDescription: string;
  userGuidance?: string;
}

export async function generateDynamicErrorResponse(params: DynamicErrorParams): Promise<string> {
  const { problemDescription, userGuidance } = params;

  try {
    const systemPrompt = new SystemMessage(
      "Você é a Bia, uma assistente virtual amigável, atenciosa e feminina no WhatsApp.\n" +
      "Ocorreu uma situação técnica interna ao tentar processar a solicitação do usuário.\n\n" +
      `SITUAÇÃO INTERNA: ${problemDescription}\n` +
      (userGuidance ? `ORIENTAÇÃO ADICIONAL: ${userGuidance}\n` : "") +
      "\n" +
      "REGRA ABSOLUTA — NUNCA TENTE EXECUTAR O PEDIDO DO USUÁRIO:\n" +
      "- Sua ÚNICA função é avisar que houve uma falha técnica. NÃO responda, resuma, execute, pesquise ou resolva NADA do que o usuário pediu.\n" +
      "- NÃO invente nem afirme ter feito qualquer ação (ex: 'ouvi os áudios', 'consultei o grupo', 'verifiquei seus e-mails'). Você NÃO executou nada.\n" +
      "- NÃO use o conteúdo das mensagens anteriores como base para dar uma resposta 'útil' sobre o assunto delas.\n" +
      "- Se o usuário pediu algo específico (ex: resumir áudios, buscar dados, enviar mensagem), NÃO faça — apenas informe que não foi possível processar agora.\n" +
      "- Redija uma resposta curta, em tom conversacional e empático (como uma pessoa real no WhatsApp), explicando de forma simples e sem termos técnicos que ocorreu uma instabilidade e pedindo para o usuário tentar novamente em instantes.\n" +
      "- NUNCA diga 'ocorreu uma exceção' ou termos de programação. Mantenha a persona da Bia (feminino, carinhosa, eficiente).\n" +
      "- Responda APENAS com o texto da mensagem para o usuário, sem aspas adicionais ou formatação markdown estruturada."
    );

    // ATENÇÃO: NÃO incluir o histórico do usuário aqui. Injetar as mensagens anteriores
    // faz o LLM 'ajudar' respondendo ao pedido original (confabulação). A resposta de
    // erro deve ser genérica e desvinculada do conteúdo da solicitação.
    const response = await model.invoke([systemPrompt]);
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
