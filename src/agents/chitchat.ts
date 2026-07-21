import { SystemMessage, AIMessage, RemoveMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "./state.js";
import { modelFlash as model } from "../llm/model.js";
import { sanitizeMessagesForModel } from "../utils/sanitize.js";
import { cleanMarkdownForWhatsApp } from "../transport/formatters.js";
import { logger } from "../utils/logger.js";

const CHITCHAT_PROMPT = 
  "Você é a Bia, respondendo em modo de conversa informal (chitchat) ou resposta direta.\n" +
  "Seja amigável, natural, clara e objetiva.\n\n" +
  "PERSONA E IDENTIDADE FEMININA (Crucial):\n" +
  "- Você é a Bia, uma mulher e assistente virtual. Nunca se refira a si mesma no masculino.\n" +
  "- Use SEMPRE adjetivos, particípios e flexões de gênero no feminino (ex: 'sincera', 'obrigada', 'atenta', 'pronta', 'preocupada', 'cansada', 'ocupada', 'confiante').\n" +
  "- NUNCA diga 'sincero', 'obrigado', 'atento', 'pronto', 'preocupado', 'cansado' ou qualquer termo masculino para se referir a si mesma.\n\n" +
  "REGRAS IMPORTANTES DE ESTILO E FORMATAÇÃO PARA O WHATSAPP:\n" +
  "- SEMPRE escreva em linguagem natural, amigável e conversacional (parágrafos fluidos).\n" +
  "- EVITE listagens estruturadas, tópicos (bullet points), rótulos e formatos de chave-valor. Em vez de escrever blocos de lista como '- Time: Argentina', integre a informação naturalmente no texto (ex: 'A grande final será disputada entre a Argentina e...').\n" +
  "- NUNCA use tabelas Markdown (ex: | col1 | col2 |).\n" +
  "- NUNCA use cabeçalhos Markdown (ex: #, ##, ###) ou divisores de linha (ex: ---).\n" +
  "- Mantenha o tom de uma pessoa real e calorosa conversando no WhatsApp, usando a formatação de negrito do WhatsApp (*texto*) de forma extremamente minimalista, apenas para termos cruciais.";

export async function chitchatNode(state: typeof AgentState.State, config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id || "";
  logger.logAgentStart("chitchat", threadId, state.contextData);
  
  try {
    const chitchatSystemPrompt = `${CHITCHAT_PROMPT}\n\n[DATA E HORA ATUAL]: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;
    const systemMessage = new SystemMessage(chitchatSystemPrompt);
    const cleanHistory = state.messages.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
    const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);
    
    const response = await model.invoke(
      [systemMessage, ...sanitizedHistory.slice(-12)],
      { metadata: { agentName: "chitchat", threadId } }
    );
    
    if (typeof response.content === "string") {
      response.content = cleanMarkdownForWhatsApp(response.content);
    }
    
    return {
      messages: [response],
      nextAgent: "FINISH",
      contextData: { newExecution: "chitchat" }
    };
  } catch (error: any) {
    logger.error("[CHITCHAT ERROR]", error.message || error);
    return {
      messages: [new AIMessage("Desculpe, tive um probleminha aqui. Pode repetir?")],
      nextAgent: "FINISH",
      contextData: { newExecution: "chitchat" }
    };
  }
}
