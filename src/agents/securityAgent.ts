import { AIMessage } from "@langchain/core/messages";
import { AgentState } from "./state.js";
import { sendIntermediateMessage, connectToWhatsApp, disconnectFromWhatsApp, isWhatsAppConnected } from "../transport/whatsapp.js";
import { addTrustedChat, removeTrustedChat, isTrustedChat, listTrustedChats, MASTER_NUMBER, MASTER_JIDS } from "../memory/security.js";
import { saveRoutine, getAllActiveRoutines } from "../memory/routines.js";
import { addIgnoredGroup, removeIgnoredGroup, getAllIgnoredGroups, normalizeText } from "../config/ignoredGroups.js";
import { logger } from "../utils/logger.js";
import { modelFlash as model } from "../llm/model.js";
import { sanitizeMessagesForModel } from "../utils/sanitize.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { formatJidForUser } from "../utils/jidResolver.js";

// Tools for the master to manage trusted chats
export const addTrustedChatTool = tool(
  async ({ jid }) => {
    try {
      await addTrustedChat(jid);
      
      try {
        await sendIntermediateMessage(jid, "✅ Boas notícias! O administrador acabou de autorizar este chat. Você já pode me pedir o que precisava.");
      } catch (err) {
        logger.error("Erro ao notificar chat aprovado:", err);
      }

      return `O número ${await formatJidForUser(jid)} foi adicionado à lista de chats de confiança.`;
    } catch (e: any) {
      return `Erro ao adicionar número de confiança: ${e.message}`;
    }
  },
  {
    name: "add_trusted_chat",
    description: "Adiciona um número de usuário ou JID à lista de chats de CONFIANÇA (concede permissão para o usuário consultar agenda, e-mails e dados sensíveis). ATENÇÃO: NUNCA use esta ferramenta quando o usuário pedir para monitorar ou acompanhar grupos para resumos diários! Para isso, use add_daily_summary_group.",
    schema: z.object({
      jid: z.string().describe("O JID do WhatsApp a ser adicionado à lista de confiança (ex: 5511999999999@s.whatsapp.net)"),
    }),
  }
);

export const removeTrustedChatTool = tool(
  async ({ jid }) => {
    try {
      await removeTrustedChat(jid);
      return `O número ${await formatJidForUser(jid)} foi removido da lista de chats de confiança.`;
    } catch (e: any) {
      return `Erro ao remover número de confiança: ${e.message}`;
    }
  },
  {
    name: "remove_trusted_chat",
    description: "Remove um número (JID) da lista de chats de confiança.",
    schema: z.object({
      jid: z.string().describe("O JID do WhatsApp a ser removido."),
    }),
  }
);

export const checkTrustTool = tool(
  async ({ jid }) => {
    try {
      const isTrusted = await isTrustedChat(jid);
      const cleanJid = await formatJidForUser(jid);
      return isTrusted ? `O número ${cleanJid} É de confiança.` : `O número ${cleanJid} NÃO é de confiança.`;
    } catch (e: any) {
      return `Erro ao verificar número: ${e.message}`;
    }
  },
  {
    name: "check_trust",
    description: "Verifica se um número (JID) está na lista de chats de confiança.",
    schema: z.object({
      jid: z.string().describe("O JID do WhatsApp a ser verificado."),
    }),
  }
);

export const listTrustedChatsTool = tool(
  async () => {
    try {
      const chats = await listTrustedChats();
      if (chats.length === 0) {
        return "Atualmente não há nenhum número na lista de chats de confiança (além do master).";
      }
      const list = await Promise.all(chats.map(async c => `- ${await formatJidForUser(c.jid)} (Adicionado em: ${new Date(c.addedAt).toLocaleString('pt-BR')})`));
      return `Chats de confiança atuais:\n${list.join('\n')}`;
    } catch (e: any) {
      return `Erro ao listar chats de confiança: ${e.message}`;
    }
  },
  {
    name: "list_trusted_chats",
    description: "Lista todos os números (JIDs) que estão atualmente na lista de chats de confiança.",
    schema: z.object({}),
  }
);

export const getMasterInfoTool = tool(
  async () => {
    return `O número Master (administrador) configurado no sistema é: ${await formatJidForUser(MASTER_NUMBER)}`;
  },
  {
    name: "get_master_info",
    description: "Retorna qual é o número Master (administrador) atual do sistema.",
    schema: z.object({}),
  }
);

export const connectPersonalAccountTool = tool(
  async () => {
    try {
      if (isWhatsAppConnected('personal')) {
        return "A conta pessoal já está conectada e operando.";
      }
      
      connectToWhatsApp('personal').catch(err => {
         logger.error("Erro ao conectar conta pessoal dinamicamente:", err);
      });
      
      return "O processo de conexão da conta pessoal foi iniciado! Verifique o console do servidor, o QR Code deve aparecer lá nos próximos segundos para você escanear.";
    } catch (e: any) {
      return `Erro ao iniciar conexão: ${e.message}`;
    }
  },
  {
    name: "connect_personal_account",
    description: "Inicia a conexão do WhatsApp para a conta pessoal do administrador. O sistema vai gerar o QR Code no terminal do servidor, ou conectar diretamente caso a sessão já exista.",
    schema: z.object({}),
  }
);

export const disconnectPersonalAccountTool = tool(
  async () => {
    try {
      if (!isWhatsAppConnected('personal')) {
        return "A conta pessoal já está desconectada ou inativa.";
      }
      
      await disconnectFromWhatsApp('personal', true);
      return "A conta pessoal foi desconectada com sucesso e a sessão foi removida. Para voltar a monitorar, será necessário solicitar o pareamento novamente.";
    } catch (e: any) {
      return `Erro ao desconectar conta: ${e.message}`;
    }
  },
  {
    name: "disconnect_personal_account",
    description: "Desconecta e faz logout da conta pessoal do administrador do sistema, parando o monitoramento.",
    schema: z.object({}),
  }
);

export const checkPersonalAccountStatusTool = tool(
  async () => {
    try {
      if (isWhatsAppConnected('personal')) {
        return "A conta pessoal está ATUALMENTE CONECTADA e sendo monitorada em tempo real.";
      } else {
        return "A conta pessoal está DESCONECTADA no momento. O monitoramento não está ativo.";
      }
    } catch (e: any) {
      return `Erro ao checar status: ${e.message}`;
    }
  },
  {
    name: "check_personal_account_status",
    description: "Verifica se a conta pessoal do administrador está conectada e sendo monitorada no momento.",
    schema: z.object({}),
  }
);

export const ignoreGroupTool = tool(
  async ({ target, name }, config) => {
    try {
      const state = config.configurable as any;
      const currentChatJid = state?.contextData?.chatJid;

      let jidToIgnore = target?.trim() || "";
      let nameToIgnore = name?.trim() || target?.trim() || "";

      if (!jidToIgnore || jidToIgnore.toLowerCase() === "atual" || jidToIgnore.toLowerCase() === "este grupo" || jidToIgnore.toLowerCase() === "aqui") {
        if (currentChatJid && currentChatJid.endsWith('@g.us')) {
          jidToIgnore = currentChatJid;
          nameToIgnore = nameToIgnore || currentChatJid;
        }
      }

      if (!jidToIgnore && !nameToIgnore) {
        return "Erro: É necessário informar o nome ou o JID do grupo a ser ignorado.";
      }

      // Tenta resolver o JID real do grupo se apenas o nome foi informado
      if (!jidToIgnore.endsWith('@g.us')) {
        try {
          const { getAllGroups } = await import("../transport/whatsapp.js");
          const mainGroups = await getAllGroups('main');
          const personalGroups = await getAllGroups('personal');
          const allGroups = [...mainGroups, ...personalGroups];

          const searchName = normalizeText(nameToIgnore || jidToIgnore);
          const matchedGroup = allGroups.find(g => {
            const gNorm = normalizeText(g.name);
            return gNorm === searchName || gNorm.includes(searchName) || searchName.includes(gNorm);
          });

          if (matchedGroup) {
            jidToIgnore = matchedGroup.jid;
            nameToIgnore = matchedGroup.name;
            logger.info(`[SECURITY_AGENT] Grupo "${nameToIgnore}" resolvido para JID: ${jidToIgnore}`);
          }
        } catch (e) {
          logger.warn('[SECURITY_AGENT] Não foi possível consultar grupos das contas conectadas:', e);
        }
      } else if (jidToIgnore.endsWith('@g.us') && (!nameToIgnore || nameToIgnore === jidToIgnore)) {
        try {
          const { getAllGroups } = await import("../transport/whatsapp.js");
          const allGroups = [...(await getAllGroups('main')), ...(await getAllGroups('personal'))];
          const matchedGroup = allGroups.find(g => g.jid === jidToIgnore);
          if (matchedGroup) {
            nameToIgnore = matchedGroup.name;
          }
        } catch (e) {}
      }

      const success = addIgnoredGroup(jidToIgnore || `name:${nameToIgnore}`, nameToIgnore || jidToIgnore);
      if (success) {
        return `✅ O grupo "${nameToIgnore || jidToIgnore}" (${jidToIgnore}) foi adicionado à lista de grupos ignorados. As mensagens dele serão descartadas automaticamente.`;
      } else {
        return `O grupo "${nameToIgnore || jidToIgnore}" (${jidToIgnore}) já está na lista de grupos ignorados.`;
      }
    } catch (e: any) {
      return `Erro ao ignorar grupo: ${e.message}`;
    }
  },
  {
    name: "ignore_group",
    description: "Adiciona um grupo do WhatsApp à lista de grupos ignorados. Aceita o nome do grupo, JID, ou 'este grupo'/'atual' para se referir ao chat atual.",
    schema: z.object({
      target: z.string().optional().describe("O nome do grupo, JID ou 'este grupo'/'atual' para referir-se ao chat atual."),
      name: z.string().optional().describe("Nome amigável do grupo, se disponível."),
    }),
  }
);

export const unignoreGroupTool = tool(
  async ({ target }, config) => {
    try {
      const state = config.configurable as any;
      const currentChatJid = state?.contextData?.chatJid;

      let jidToUnignore = target?.trim() || "";
      if (!jidToUnignore || jidToUnignore.toLowerCase() === "atual" || jidToUnignore.toLowerCase() === "este grupo" || jidToUnignore.toLowerCase() === "aqui") {
        if (currentChatJid) {
          jidToUnignore = currentChatJid;
        }
      }

      if (!jidToUnignore) {
        return "Erro: É necessário informar o nome ou JID do grupo a ser retirado da lista de ignorados.";
      }

      // Tenta resolver o grupo nas contas conectadas para garantir remoção precisa
      if (!jidToUnignore.endsWith('@g.us')) {
        try {
          const { getAllGroups } = await import("../transport/whatsapp.js");
          const allGroups = [...(await getAllGroups('main')), ...(await getAllGroups('personal'))];
          const searchName = normalizeText(jidToUnignore);
          const matchedGroup = allGroups.find(g => {
            const gNorm = normalizeText(g.name);
            return gNorm === searchName || gNorm.includes(searchName) || searchName.includes(gNorm);
          });

          if (matchedGroup) {
            const removedByJid = removeIgnoredGroup(matchedGroup.jid);
            if (removedByJid) {
              return `✅ O grupo "${matchedGroup.name}" (${matchedGroup.jid}) foi removido da lista de grupos ignorados. Voltei a acompanhar mensagens deste grupo.`;
            }
          }
        } catch (e) {}
      }

      const success = removeIgnoredGroup(jidToUnignore);
      if (success) {
        return `✅ O grupo "${jidToUnignore}" foi removido da lista de grupos ignorados. Voltei a acompanhar mensagens deste grupo.`;
      } else {
        return `O grupo "${jidToUnignore}" não foi encontrado na lista de grupos ignorados.`;
      }
    } catch (e: any) {
      return `Erro ao remover grupo dos ignorados: ${e.message}`;
    }
  },
  {
    name: "unignore_group",
    description: "Remove um grupo da lista de grupos ignorados, voltando a acompanhar e atender o grupo.",
    schema: z.object({
      target: z.string().describe("O nome do grupo, JID ou 'este grupo' para referir-se ao chat atual."),
    }),
  }
);

export const listIgnoredGroupsTool = tool(
  async () => {
    try {
      const groups = getAllIgnoredGroups();
      if (groups.length === 0) {
        return "Atualmente não há nenhum grupo na lista de ignorados.";
      }
      const list = groups.map(g => `- **${g.name || g.jid}** (${g.jid}) - Ignorado em: ${new Date(g.ignoredAt).toLocaleString('pt-BR')}`).join('\n');
      return `Grupos ignorados atualmente:\n${list}`;
    } catch (e: any) {
      return `Erro ao listar grupos ignorados: ${e.message}`;
    }
  },
  {
    name: "list_ignored_groups",
    description: "Lista todos os grupos do WhatsApp que a Bia está ignorando atualmente.",
    schema: z.object({}),
  }
);

const securityTools = [
  addTrustedChatTool, 
  removeTrustedChatTool, 
  checkTrustTool, 
  listTrustedChatsTool, 
  getMasterInfoTool, 
  connectPersonalAccountTool, 
  disconnectPersonalAccountTool, 
  checkPersonalAccountStatusTool,
  ignoreGroupTool,
  unignoreGroupTool,
  listIgnoredGroupsTool
];

import { getSkill } from "../skills/registry.js";

const SECURITY_PROMPT = getSkill("securityAgent")?.detailedPrompt || "";

const securityReactAgent = createReactAgent({
  llm: model,
  tools: securityTools,
  messageModifier: SECURITY_PROMPT
});

export async function securityAgentNode(state: typeof AgentState.State) {
  const context = state.contextData;
  const isTrusted = context.isTrustedChat;
  const isMaster = !!context.chatJid && MASTER_JIDS.includes(context.chatJid);
  let responseText = "";

  logger.logAgentStart("securityAgent", context.chatJid || "", context);
  logger.info(`[SECURITY AGENT] Executando... isTrusted: ${isTrusted}, isMaster: ${isMaster}, chatJid: ${context.chatJid}`);

  // Se o usuário não é de confiança e está tentando acessar dados:
  if (!isTrusted) {
    // Resposta para o usuário bloqueado
    responseText = "Por questões de segurança, eu não tenho permissão para acessar essa informação ou realizar essa tarefa por aqui.";
  } else if (isMaster) {
    // Se for o master, processa o pedido via ReactAgent para executar ferramentas de adição/remoção
    const sanitizedHistory = sanitizeMessagesForModel(state.messages);
    const result = await securityReactAgent.invoke({
      messages: sanitizedHistory
    });
    const lastMessage = result.messages[result.messages.length - 1];
    responseText = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);
  } else {
    // Se for um chat confiável mas que acionou o securityAgent (improvável, mas possível se derem um comando de segurança)
    responseText = "Você já é um contato de confiança! Porém, apenas o administrador principal (Master) pode gerenciar ou adicionar outras pessoas na lista de confiança.";
  }

  return {
    messages: [new AIMessage(responseText)],
    nextAgent: "supervisor",
    contextData: { newExecution: "securityAgent" }
  };
}
