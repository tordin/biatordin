import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { getChatHistory, listRecentChats, searchChatByName } from "../memory/chatHistory.js";
import { getAllGroups, isWhatsAppConnected, notifyMaster, sendPersonalMessageNow } from "../transport/whatsapp.js";
import { createMessageApprovalToken, isAutoReplyChat } from "../memory/security.js";
import { getSkill } from "../skills/registry.js";

const WHATSAPP_AGENT_PROMPT = getSkill("whatsappAgent")?.detailedPrompt || "";

export const listRecentChatsTool = tool(
  async ({ accountName, limit }) => {
    const result = listRecentChats(accountName, limit || 5);

    // Enrich group names using getAllGroups (preserved from original logic)
    const allGroups = await getAllGroups(accountName);
    const groupMap = new Map(allGroups.map((g: any) => [g.jid, g.name]));

    for (const r of result) {
      if (r.chatJid.endsWith("@g.us")) {
        const realName = groupMap.get(r.chatJid);
        if (realName) r.name = realName;
        else if (r.name && !r.name.includes("Grupo")) r.name = `Grupo (Última msg de: ${r.name})`;
      }
    }

    return JSON.stringify(result, null, 2);
  },
  {
    name: "listRecentChats",
    description: "Lista os chats que tiveram mensagens recentemente.",
    schema: z.object({
      accountName: z.enum(["main", "personal"]).describe("A conta do WhatsApp ('main' ou 'personal')."),
      limit: z.number().optional().describe("Número máximo de chats para retornar (padrão 5)"),
    }),
  }
);

export const getChatHistoryTool = tool(
  async ({ accountName, chatJid, limit }) => {
    const result = getChatHistory(accountName, chatJid, limit || 20);
    return JSON.stringify(result, null, 2);
  },
  {
    name: "getChatHistory",
    description: "Lê o histórico recente de mensagens de um chat específico.",
    schema: z.object({
      accountName: z.enum(["main", "personal"]).describe("A conta do WhatsApp ('main' ou 'personal')."),
      chatJid: z.string().describe("O JID do chat (ex: 551999999999@s.whatsapp.net)"),
      limit: z.number().optional().describe("Número máximo de mensagens para ler (padrão 20)"),
    }),
  }
);

export const searchChatByNameTool = tool(
  async ({ accountName, queryName }) => {
    const result = searchChatByName(accountName, queryName);

    // Enrich group names using getAllGroups (preserved from original logic)
    const allGroups = await getAllGroups(accountName);
    const groupMap = new Map(allGroups.map((g: any) => [g.jid, g.name]));

    for (const r of result) {
      if (r.chatJid.endsWith("@g.us")) {
        const realName = groupMap.get(r.chatJid);
        if (realName) r.name = realName;
        else if (!r.name.includes("Grupo")) r.name = `Grupo (Última msg de: ${r.name})`;
      }
    }

    let content = JSON.stringify(result, null, 2);
    if (result.length === 0) {
      content = `Nenhum chat encontrado com o nome '${queryName}' na conta '${accountName}'. DICA: Você DEVE tentar pesquisar na outra conta (se usou 'main', tente 'personal', e vice-versa) ou usar listRecentChats.`;
    }

    return content;
  },
  {
    name: "searchChatByName",
    description: "Busca o JID de um chat pelo nome do contato ou do grupo.",
    schema: z.object({
      accountName: z.enum(["main", "personal"]).describe("A conta do WhatsApp ('main' ou 'personal')."),
      queryName: z.string().describe("O nome a ser pesquisado (ex: o nome que o usuário forneceu explicitamente na mensagem dele)"),
    }),
  }
);

export const searchGroupsTool = tool(
  async ({ accountName, queryName }) => {
    const allGroups = await getAllGroups(accountName);
    const query = (queryName || "").toLowerCase();
    const filtered = query
      ? allGroups.filter((g: any) => g.name && g.name.toLowerCase().includes(query))
      : allGroups;
    let content = JSON.stringify(filtered, null, 2);
    if (filtered.length === 0) {
      content = `Nenhum grupo encontrado com o nome '${query}' na conta '${accountName}'. Aqui estão todos os grupos disponíveis:\n\n${JSON.stringify(allGroups.map((g: any) => g.name), null, 2)}`;
    }
    return content;
  },
  {
    name: "searchGroups",
    description: "Busca todos os grupos que o usuário participa no WhatsApp. Use isso se não encontrar um grupo no histórico recente, ou para ver todos os grupos disponíveis.",
    schema: z.object({
      accountName: z.enum(["main", "personal"]).describe("A conta do WhatsApp ('main' ou 'personal')."),
      queryName: z.string().optional().describe("Nome parcial do grupo para filtrar. Se não tiver certeza, deixe vazio para retornar todos."),
    }),
  }
);

export const sendPersonalMessageTool = tool(
  async ({ targetJid, message, targetName }, config) => {
    if (typeof targetJid !== "string" || !targetJid.includes("@")) {
      return `ERRO: O targetJid fornecido ('${targetJid}') é inválido. Você DEVE usar um JID real do WhatsApp (terminado em @s.whatsapp.net ou @g.us). Use listRecentChats primeiro para descobrir o JID correto da pessoa.`;
    }

    if (!isWhatsAppConnected("personal")) {
      return "ERRO: A conta pessoal não está conectada. Não é possível enviar.";
    }

    const isAutoReply = await isAutoReplyChat(targetJid);

    if (isAutoReply) {
      const success = await sendPersonalMessageNow(targetJid, message);
      if (success) {
        return "Sucesso. A mensagem foi enviada IMEDIATAMENTE (bypass por whitelist) na conta pessoal. Sua tarefa de envio está totalmente CONCLUÍDA.";
      } else {
        return "FALHA ao enviar a mensagem via bypass (socket desconectado ou erro).";
      }
    }

    const token = createMessageApprovalToken(targetJid, message);

    // Determine if this is an incoming personal message based on the conversation context
    const accountName = config?.configurable?.contextData?.accountName || "main";
    const isIncomingPersonal = accountName === "personal";
    const headerTitle = isIncomingPersonal
      ? "💡 *Sugestão de Resposta na Conta Pessoal*"
      : "🚨 *Autorização de Envio na Conta Pessoal*";
    const introText = isIncomingPersonal
      ? `A Bia sugere enviar a seguinte resposta para *${targetName || targetJid}*:`
      : `A Bia deseja enviar a seguinte mensagem para *${targetName || targetJid}*:`;

    const notificationText = `${headerTitle}\n\n${introText}\n\n"${message}"\n\nPara autorizar e enviar imediatamente, responda com:\n*ENVIAR ${token}*`;

    await notifyMaster(notificationText);

    return "Sucesso. A mensagem foi retida pela camada de segurança e o usuário foi notificado para aprovação. O envio ocorrerá automaticamente no background após a aprovação dele. Sua tarefa de envio está totalmente CONCLUÍDA.";
  },
  {
    name: "send_personal_message",
    description: "Envia uma mensagem na conta pessoal do WhatsApp. A mensagem será automaticamente retida pela camada de segurança, que pedirá aprovação ao usuário. Você só precisa chamar esta ferramenta para concluir sua parte do envio.",
    schema: z.object({
      targetJid: z.string().describe("O JID do contato de destino (ex: 551999999999@s.whatsapp.net). Se você não sabe o JID exato, use listRecentChats primeiro para descobrir."),
      message: z.string().describe("A mensagem completa que será enviada"),
      targetName: z.string().optional().describe("O nome de exibição do contato (para ficar bonito na notificação)"),
    }),
  }
);

const whatsappAgent = createReactAgent({
  llm: model,
  tools: [listRecentChatsTool, getChatHistoryTool, searchChatByNameTool, searchGroupsTool, sendPersonalMessageTool],
  messageModifier: WHATSAPP_AGENT_PROMPT,
});

export async function whatsappAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("whatsappAgent", () => whatsappAgent, state, undefined, config);
}
