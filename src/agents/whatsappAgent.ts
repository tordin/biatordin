import { SystemMessage, AIMessage, ToolMessage, RemoveMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { AgentState } from "./state.js";
import { modelPro as model } from "../llm/model.js";
import { sanitizeMessagesForModel } from "../utils/sanitize.js";
import { logger } from "../utils/logger.js";
import { getChatHistory, listRecentChats, searchChatByName } from "../memory/chatHistory.js";

const WHATSAPP_AGENT_PROMPT = 
  "Você é a Bia, atuando agora como a Especialista em Histórico do WhatsApp.\n" +
  "Sua função é consultar o histórico local de conversas do WhatsApp (da conta personal ou main) para entender o que foi dito, encontrar informações específicas ou resumir chats recentes.\n" +
  "Você tem acesso a quatro ferramentas principais:\n" +
  "1. listRecentChats: Lista os chats recentes (retorna JID e Nome).\n" +
  "2. searchChatByName: Busca o JID de um chat pelo nome da pessoa.\n" +
  "3. getChatHistory: Lê o histórico de mensagens de um JID.\n" +
  "4. send_personal_message: Envia mensagem na conta pessoal.\n" +
  "5. searchGroups: Lista ou busca grupos em que a conta participa (API real, útil se o grupo não estiver no histórico).\n\n" +
  "PERSONA E IDENTIDADE FEMININA:\n" +
  "- Você é a Bia, uma mulher.\n" +
  "- Responda de forma natural, amigável e direta para o usuário (ou para o supervisor).\n" +
  "- NUNCA diga que você não tem acesso ao WhatsApp; você TEM acesso ao histórico salvo localmente.\n\n" +
  "REGRAS CRÍTICAS DE FOCO E ALUCINAÇÃO:\n" +
  "- CONCENTRE-SE ABSOLUTAMENTE NA MENSAGEM MAIS RECENTE do usuário. Se o histórico contiver pedidos antigos (como 'enviar mensagem para X'), IGNORE-OS completamente.\n" +
  "- NUNCA INVENTE NOMES de contatos ou grupos. Se o usuário não disser um nome, não tente adivinhar.\n" +
  "- NUNCA tente realizar ações (como enviar mensagens) sem que o usuário tenha pedido de forma explícita e clara na mensagem mais recente.\n\n" +
  "REGRAS:\n" +
  "- Se o usuário perguntar de forma genérica 'tem alguma mensagem nova?', use listRecentChats, escolha o chat mais recente e depois use getChatHistory para ver o que é.\n" +
  "- Se o usuário já informou de quem é a mensagem, você pode precisar listar os chats para encontrar o JID correto (se não souber), e então buscar o histórico.\n" +
  "- Após consultar a informação, gere uma resposta amigável resumindo o que você encontrou.";

export async function whatsappAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id || "";
  logger.logAgentStart("whatsappAgent", threadId, state.contextData);

  const accountName = state.contextData.accountName || "main"; 

  const systemPrompt = new SystemMessage(
    `${WHATSAPP_AGENT_PROMPT}\n\n[DICA]: O usuário atual está conversando com você pela conta '${accountName}'. Se ele pedir para ver o 'pessoal' ou 'meu whatsapp', a conta que você deve consultar é 'personal'.`
  );

  const cleanHistory = state.messages.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
  const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);

  let currentMessages: any[] = [systemPrompt, ...sanitizedHistory.slice(-5)];
  
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "listRecentChats",
        description: "Lista os chats que tiveram mensagens recentemente.",
        parameters: {
          type: "object",
          properties: {
            accountName: {
              type: "string",
              description: "A conta do WhatsApp ('main' ou 'personal').",
              enum: ["main", "personal"]
            },
            limit: {
              type: "number",
              description: "Número máximo de chats para retornar (padrão 5)"
            }
          },
          required: ["accountName"]
        }
      }
    },
    {
      type: "function" as const,
      function: {
        name: "searchChatByName",
        description: "Busca o JID de um chat pelo nome do contato ou do grupo.",
        parameters: {
          type: "object",
          properties: {
            accountName: {
              type: "string",
              description: "A conta do WhatsApp ('main' ou 'personal').",
              enum: ["main", "personal"]
            },
            queryName: {
              type: "string",
              description: "O nome a ser pesquisado (ex: o nome que o usuário forneceu explicitamente na mensagem dele)"
            }
          },
          required: ["accountName", "queryName"]
        }
      }
    },
    {
      type: "function" as const,
      function: {
        name: "getChatHistory",
        description: "Lê o histórico recente de mensagens de um chat específico.",
        parameters: {
          type: "object",
          properties: {
            accountName: {
              type: "string",
              description: "A conta do WhatsApp ('main' ou 'personal').",
              enum: ["main", "personal"]
            },
            chatJid: {
              type: "string",
              description: "O JID do chat (ex: 551999999999@s.whatsapp.net)"
            },
            limit: {
              type: "number",
              description: "Número máximo de mensagens para ler (padrão 20)"
            }
          },
          required: ["accountName", "chatJid"]
        }
      }
    },
    {
      type: "function" as const,
      function: {
        name: "send_personal_message",
        description: "Envia uma mensagem na conta pessoal do WhatsApp. A mensagem será automaticamente retida pela camada de segurança, que pedirá aprovação ao usuário. Você só precisa chamar esta ferramenta para concluir sua parte do envio.",
        parameters: {
          type: "object",
          properties: {
            targetJid: {
              type: "string",
              description: "O JID do contato de destino (ex: 551999999999@s.whatsapp.net). Se você não sabe o JID exato, use listRecentChats primeiro para descobrir."
            },
            message: {
              type: "string",
              description: "A mensagem completa que será enviada"
            },
            targetName: {
              type: "string",
              description: "O nome de exibição do contato (para ficar bonito na notificação)"
            }
          },
          required: ["targetJid", "message"]
        }
      }
    },
    {
      type: "function" as const,
      function: {
        name: "searchGroups",
        description: "Busca todos os grupos que o usuário participa no WhatsApp. Use isso se não encontrar um grupo no histórico recente, ou para ver todos os grupos disponíveis.",
        parameters: {
          type: "object",
          properties: {
            accountName: {
              type: "string",
              description: "A conta do WhatsApp ('main' ou 'personal').",
              enum: ["main", "personal"]
            },
            queryName: {
              type: "string",
              description: "Nome parcial do grupo para filtrar. Se não tiver certeza, deixe vazio para retornar todos."
            }
          },
          required: ["accountName"]
        }
      }
    }
  ];

  let iterations = 0;
  const maxIterations = 15;

  while (iterations < maxIterations) {
    try {
      const response = await model.invoke(currentMessages, {
        tools: tools,
        metadata: { agentName: "whatsappAgent", threadId }
      });

      currentMessages.push(response);

      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const call of response.tool_calls) {
          if (call.name === "listRecentChats") {
            const result = listRecentChats(call.args.accountName as string, (call.args.limit as number) || 5);
            
            const { getAllGroups } = await import("../transport/whatsapp.js");
            const allGroups = await getAllGroups(call.args.accountName as string);
            const groupMap = new Map(allGroups.map((g: any) => [g.jid, g.name]));
            
            for (const r of result) {
              if (r.chatJid.endsWith('@g.us')) {
                const realName = groupMap.get(r.chatJid);
                if (realName) r.name = realName;
                else if (r.name && !r.name.includes("Grupo")) r.name = `Grupo (Última msg de: ${r.name})`;
              }
            }

            currentMessages.push(new ToolMessage({
              tool_call_id: call.id || "",
              content: JSON.stringify(result, null, 2),
              name: call.name
            }));
          } else if (call.name === "getChatHistory") {
            const result = getChatHistory(call.args.accountName as string, call.args.chatJid as string, (call.args.limit as number) || 20);
            currentMessages.push(new ToolMessage({
              tool_call_id: call.id || "",
              content: JSON.stringify(result, null, 2),
              name: call.name
            }));
          } else if (call.name === "searchChatByName") {
            const result = searchChatByName(call.args.accountName as string, call.args.queryName as string);
            
            const { getAllGroups } = await import("../transport/whatsapp.js");
            const allGroups = await getAllGroups(call.args.accountName as string);
            const groupMap = new Map(allGroups.map((g: any) => [g.jid, g.name]));
            
            for (const r of result) {
              if (r.chatJid.endsWith('@g.us')) {
                const realName = groupMap.get(r.chatJid);
                if (realName) r.name = realName;
                else if (!r.name.includes("Grupo")) r.name = `Grupo (Última msg de: ${r.name})`;
              }
            }

            let content = JSON.stringify(result, null, 2);
            if (result.length === 0) {
              content = `Nenhum chat encontrado com o nome '${call.args.queryName}' na conta '${call.args.accountName}'. DICA: Você DEVE tentar pesquisar na outra conta (se usou 'main', tente 'personal', e vice-versa) ou usar listRecentChats.`;
            }
            currentMessages.push(new ToolMessage({
              tool_call_id: call.id || "",
              content: content,
              name: call.name
            }));
          } else if (call.name === "searchGroups") {
            const { getAllGroups } = await import("../transport/whatsapp.js");
            const allGroups = await getAllGroups(call.args.accountName as string);
            const query = (call.args.queryName as string || "").toLowerCase();
            const filtered = query 
              ? allGroups.filter((g: any) => g.name && g.name.toLowerCase().includes(query))
              : allGroups;
            let content = JSON.stringify(filtered, null, 2);
            if (filtered.length === 0) {
              content = `Nenhum grupo encontrado com o nome '${query}' na conta '${call.args.accountName}'. Aqui estão todos os grupos disponíveis:\n\n${JSON.stringify(allGroups.map((g: any) => g.name), null, 2)}`;
            }
            currentMessages.push(new ToolMessage({
              tool_call_id: call.id || "",
              content: content,
              name: call.name
            }));
          } else if (call.name === "send_personal_message") {
            const { targetJid, message, targetName } = call.args;
            if (typeof targetJid !== 'string' || !targetJid.includes('@')) {
              currentMessages.push(new ToolMessage({
                tool_call_id: call.id || "",
                content: `ERRO: O targetJid fornecido ('${targetJid}') é inválido. Você DEVE usar um JID real do WhatsApp (terminado em @s.whatsapp.net ou @g.us). Use listRecentChats primeiro para descobrir o JID correto da pessoa.`,
                name: call.name
              }));
              continue;
            }
            
            const { isWhatsAppConnected, notifyMaster } = await import("../transport/whatsapp.js");
            const { createMessageApprovalToken } = await import("../memory/security.js");
            
            if (!isWhatsAppConnected('personal')) {
              currentMessages.push(new ToolMessage({
                tool_call_id: call.id || "",
                content: "ERRO: A conta pessoal não está conectada. Não é possível enviar.",
                name: call.name
              }));
              continue;
            }

            const token = createMessageApprovalToken(targetJid, message as string);
            const notificationText = `🚨 *Autorização de Envio na Conta Pessoal*\n\nA Bia deseja enviar a seguinte mensagem para *${targetName || targetJid}*:\n\n"${message}"\n\nPara autorizar e enviar imediatamente, responda com:\n*ENVIAR ${token}*`;
            
            await notifyMaster(notificationText);
            
            currentMessages.push(new ToolMessage({
              tool_call_id: call.id || "",
              content: "Sucesso. A mensagem foi retida pela camada de segurança e o usuário foi notificado para aprovação. O envio ocorrerá automaticamente no background após a aprovação dele. Sua tarefa de envio está totalmente CONCLUÍDA.",
              name: call.name
            }));
          }
        }
      } else {
        const finalContent = response.content as string;
        return {
          messages: [new AIMessage(finalContent)],
          nextAgent: "supervisor",
          contextData: { newExecution: "whatsappAgent" }
        };
      }
      iterations++;
    } catch (err: any) {
      logger.error("[WHATSAPP_AGENT ERROR]", err);
      return {
        messages: [new AIMessage("Desculpe, tive um problema ao acessar o histórico do WhatsApp. Podemos tentar de novo?")],
        nextAgent: "supervisor",
        contextData: { newExecution: "whatsappAgent" }
      };
    }
  }

  const lastMsg = currentMessages[currentMessages.length - 1];
  if (lastMsg instanceof ToolMessage && lastMsg.content && lastMsg.content.toString().includes("CONCLUÍDA")) {
    return {
      messages: [new AIMessage("A mensagem foi enviada/retida com sucesso. Tarefa concluída.")],
      nextAgent: "supervisor",
      contextData: { newExecution: "whatsappAgent" }
    };
  }

  return {
    messages: [new AIMessage("FALHA: Atingi o limite de processamento tentando analisar o histórico. Por favor, encerre a tarefa (FINISH) e informe o usuário de forma amigável que não consegui concluir a solicitação, pedindo para ser mais específico ou tentar novamente.")],
    nextAgent: "supervisor",
    contextData: { newExecution: "whatsappAgent" }
  };
}
