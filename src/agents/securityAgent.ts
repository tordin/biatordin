import { AIMessage } from "@langchain/core/messages";
import { AgentState } from "./state.js";
import { notifyMaster, sendIntermediateMessage, connectToWhatsApp, disconnectFromWhatsApp, isWhatsAppConnected } from "../transport/whatsapp.js";
import { addTrustedChat, removeTrustedChat, isTrustedChat, listTrustedChats, MASTER_NUMBER, MASTER_JIDS, createMessageApprovalToken } from "../memory/security.js";
import { logger } from "../utils/logger.js";
import { modelPro as model } from "../llm/model.js";
import { sanitizeMessagesForModel } from "../utils/sanitize.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

// Helper para limpar o sufixo @s.whatsapp.net ou @lid para exibir ao usuário
function formatJidForUser(jid?: string): string {
  if (!jid) return "";
  return jid.split('@')[0];
}

// Tools for the master to manage trusted chats
const addTrustedChatTool = tool(
  async ({ jid }) => {
    try {
      await addTrustedChat(jid);
      
      try {
        await sendIntermediateMessage(jid, "✅ Boas notícias! O administrador acabou de autorizar este chat. Você já pode me pedir o que precisava.");
      } catch (err) {
        logger.error("Erro ao notificar chat aprovado:", err);
      }

      return `O número ${formatJidForUser(jid)} foi adicionado à lista de chats de confiança.`;
    } catch (e: any) {
      return `Erro ao adicionar número de confiança: ${e.message}`;
    }
  },
  {
    name: "add_trusted_chat",
    description: "Adiciona um número (JID) à lista de chats de confiança, permitindo que a Bia acesse dados sensíveis para este usuário/grupo. O JID normalmente termina em @s.whatsapp.net ou @g.us.",
    schema: z.object({
      jid: z.string().describe("O JID do WhatsApp a ser adicionado (ex: 5511999999999@s.whatsapp.net)"),
    }),
  }
);

const removeTrustedChatTool = tool(
  async ({ jid }) => {
    try {
      await removeTrustedChat(jid);
      return `O número ${formatJidForUser(jid)} foi removido da lista de chats de confiança.`;
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

const checkTrustTool = tool(
  async ({ jid }) => {
    try {
      const isTrusted = await isTrustedChat(jid);
      const cleanJid = formatJidForUser(jid);
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

const listTrustedChatsTool = tool(
  async () => {
    try {
      const chats = await listTrustedChats();
      if (chats.length === 0) {
        return "Atualmente não há nenhum número na lista de chats de confiança (além do master).";
      }
      const list = chats.map(c => `- ${formatJidForUser(c.jid)} (Adicionado em: ${new Date(c.addedAt).toLocaleString('pt-BR')})`).join('\n');
      return `Chats de confiança atuais:\n${list}`;
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

const getMasterInfoTool = tool(
  async () => {
    return `O número Master (administrador) configurado no sistema é: ${formatJidForUser(MASTER_NUMBER)}`;
  },
  {
    name: "get_master_info",
    description: "Retorna qual é o número Master (administrador) atual do sistema.",
    schema: z.object({}),
  }
);

const connectPersonalAccountTool = tool(
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

const disconnectPersonalAccountTool = tool(
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

const checkPersonalAccountStatusTool = tool(
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

const securityTools = [addTrustedChatTool, removeTrustedChatTool, checkTrustTool, listTrustedChatsTool, getMasterInfoTool, connectPersonalAccountTool, disconnectPersonalAccountTool, checkPersonalAccountStatusTool];

const securityReactAgent = createReactAgent({
  llm: model,
  tools: securityTools,
  messageModifier: `Você é o agente de segurança da Bia. Sua função é gerenciar as permissões de acesso do sistema.
Você só tem permissão para atuar quando solicitado pelo Master (administrador).
Use as ferramentas disponíveis para adicionar, remover, listar ou consultar o status de confiança dos números.
Você também é responsável por conectar, desconectar ou checar o status da conta de monitoramento pessoal do administrador, sempre que ele solicitar.
Para pedir autorização para enviar mensagens para contatos na conta pessoal do administrador, use o request_send_personal_message.`
});

export async function securityAgentNode(state: typeof AgentState.State) {
  const context = state.contextData;
  const isTrusted = context.isTrustedChat;
  const isMaster = !!context.chatJid && MASTER_JIDS.includes(context.chatJid);
  let responseText = "";

  logger.info(`[SECURITY AGENT] Executando... isTrusted: ${isTrusted}, isMaster: ${isMaster}, chatJid: ${context.chatJid}`);

  // Se o usuário não é de confiança e está tentando acessar dados:
  if (!isTrusted) {
    // Tenta entender o que ele estava pedindo para avisar o master
    const lastHumanMsg = state.messages.slice().reverse().find(m => m._getType() === 'human');
    let userRequest = lastHumanMsg && typeof lastHumanMsg.content === 'string' ? lastHumanMsg.content : "algo sensível";
    
    // Limpa metadados injetados para não poluir o alerta
    userRequest = userRequest.replace(/\n\[Metadados do Grupo:.*?\]/g, "").trim();
    
    // Formata o pedido e avisa o master
    const formatJidForUser = (jid: string | undefined) => jid ? jid.split('@')[0] : "Desconhecido";
    const requesterJid = formatJidForUser(context.senderJid || context.chatJid);
    const requesterName = context.senderName && context.senderName !== "Desconhecido" ? context.senderName : requesterJid;
    
    const chatJid = formatJidForUser(context.chatJid);
    const chatName = context.chatName && context.chatName !== context.chatJid ? context.chatName : chatJid;

    // Apenas notifica e orienta
    const { createApprovalToken } = await import("../memory/security.js");
    const token = createApprovalToken(context.chatJid || "");

    const notificationText = `🚨 *Alerta de Segurança*\n*${requesterName}* tentou solicitar a seguinte informação sensível no chat *${chatName}*:\n"${userRequest}"\n\nPara liberar o acesso para esse chat, responda a esta mensagem com a palavra:\n*AUTORIZAR ${token}*`;
    await notifyMaster(notificationText);

    // Resposta para o usuário bloqueado
    responseText = "Por questões de segurança, eu não tenho permissão para acessar essa informação ou realizar essa tarefa por aqui. Já notifiquei o Luiz e pedi autorização. Se ele aprovar e liberar este chat, eu te aviso!";
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
    contextData: { newExecution: "securityAgent" }
  };
}
