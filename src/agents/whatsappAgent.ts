import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { getChatHistory, listRecentChats, searchChatByName, getMessagesForGroups } from "../memory/chatHistory.js";
import { getAllGroups, isWhatsAppConnected, notifyMaster } from "../transport/whatsapp.js";
import { listDailySummaryGroups, addDailySummaryGroup, removeDailySummaryGroup } from "../memory/dailySummary.js";
import { saveRoutine, getAllActiveRoutines } from "../memory/routines.js";
import { MASTER_NUMBER } from "../memory/security.js";
import { loadLidMappings, registerLidMapping, jidsMatch, canonicalJid, formatJidForUser } from '../utils/jidResolver.js';
import { saveContact } from '../memory/contacts.js';
import { getSkill } from "../skills/registry.js";

const WHATSAPP_AGENT_PROMPT = getSkill("whatsappAgent")?.detailedPrompt || "";

export const listRecentChatsTool = tool(
  async ({ accountName, limit, objective }) => {
    const result = listRecentChats(accountName, limit || 5);

    if (!isWhatsAppConnected(accountName) && result.length === 0) {
      return `<RAW_TOOL_OUTPUT>\nERRO: A conta '${accountName}' do WhatsApp não está conectada ao vivo no momento (e nenhum histórico recente foi encontrado). Avise o usuário que a conta está desconectada.\n</RAW_TOOL_OUTPUT>`;
    }

    for (const r of result) {
      r.name = await formatJidForUser(r.chatJid, accountName);
    }

    let content = result.length > 0 
      ? result.map(r => {
          const shortDate = new Date(r.lastMessageAt).toLocaleString('pt-BR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          return `- ${r.name} (ID: ${r.chatJid}) - Últ. msg: ${shortDate}`;
        }).join('\n')
      : "Nenhum chat recente encontrado.";

    if (objective && result.length > 0) {
      try {
        const filterResponse = await model.invoke([
          new SystemMessage(`Você é um filtro de dados estrito. Extraia APENAS as informações (nomes, datas, contexto essencial) que respondam ou sejam relevantes para o seguinte OBJETIVO. Descarte COMPLETAMENTE qualquer outro assunto, bate-papo paralelo, ou "ruído". Se não houver nada útil, diga "Nenhuma informação relevante encontrada".\nOBJETIVO: ${objective}`),
          new HumanMessage(`DADOS BRUTOS:\n${content}`)
        ]);
        content = typeof filterResponse.content === 'string' ? filterResponse.content : JSON.stringify(filterResponse.content);
      } catch (err: any) {
        logger.error(`[LLM Filter Error] listRecentChatsTool: ${err.message}`);
      }
    }

    return `<RAW_TOOL_OUTPUT>\n${content}\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "listRecentChats",
    description: "Lista os chats que tiveram mensagens recentemente.",
    schema: z.object({
      accountName: z.enum(["main", "personal"]).describe("A conta do WhatsApp ('main' ou 'personal')."),
      limit: z.number().optional().describe("Número máximo de chats para retornar (padrão 5)"),
      objective: z.string().optional().describe("Opcional: Descreva qual informação específica você procura (ex: 'Quem me mandou mensagem sobre escola?'). O sistema usará isso para enxugar o histórico e evitar que você leia conversas inúteis."),
    }),
  }
);

export const getChatHistoryTool = tool(
  async ({ accountName, chatJid, limit, objective }) => {
    const result = getChatHistory(accountName, chatJid, limit || 20);
    let content = result.length > 0
      ? result.map(m => {
          const shortDate = new Date(m.timestamp).toLocaleString('pt-BR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const sender = m.isFromMe ? 'Eu' : (m.senderName || m.sender);
          return `[${shortDate}] ${sender}: ${m.content}`;
        }).join('\n')
      : "Nenhuma mensagem encontrada neste chat.";
    
    if (objective && result.length > 0) {
      try {
        const filterResponse = await model.invoke([
          new SystemMessage(`Você é um filtro de dados estrito. Extraia APENAS as informações e mensagens do histórico que sejam vitais para o seguinte OBJETIVO. Descarte COMPLETAMENTE qualquer outro assunto, bate-papo, memes ou ruído irrelevante (ex: conversas sobre festas velhas, compras velhas). Se o histórico não ajudar no objetivo, responda apenas "Nenhuma informação relevante para o objetivo encontrada no histórico.".\nOBJETIVO: ${objective}`),
          new HumanMessage(`HISTÓRICO BRUTO:\n${content}`)
        ]);
        content = typeof filterResponse.content === 'string' ? filterResponse.content : JSON.stringify(filterResponse.content);
      } catch (err: any) {
        logger.error(`[LLM Filter Error] getChatHistoryTool: ${err.message}`);
      }
    }
    
    return `<RAW_TOOL_OUTPUT>\n${content}\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "getChatHistory",
    description: "Lê o histórico recente de mensagens de um chat específico.",
    schema: z.object({
      accountName: z.enum(["main", "personal"]).describe("A conta do WhatsApp ('main' ou 'personal')."),
      chatJid: z.string().describe("O JID do chat (ex: 551999999999@s.whatsapp.net)"),
      limit: z.number().optional().describe("Número máximo de mensagens para ler (padrão 20)"),
      objective: z.string().optional().describe("Opcional: Descreva exatamente o que você quer extrair desta conversa para que um pré-filtro remova distrações e reduza o seu risco de alucinar."),
    }),
  }
);

export const searchChatByNameTool = tool(
  async ({ accountName, queryName }) => {
    const result = searchChatByName(accountName, queryName);

    if (!isWhatsAppConnected(accountName) && result.length === 0) {
      return `<RAW_TOOL_OUTPUT>\nERRO: A conta '${accountName}' do WhatsApp não está conectada ao vivo no momento. Não foi possível buscar o chat '${queryName}'. Avise o usuário que a conta '${accountName}' está desconectada e pergunte se deseja conectar.\n</RAW_TOOL_OUTPUT>`;
    }

    for (const r of result) {
      r.name = await formatJidForUser(r.chatJid, accountName);
    }

    let content = result.length > 0
      ? result.slice(0, 5).map(r => `- ${r.name} (ID: ${r.chatJid})`).join('\n') + (result.length > 5 ? `\n...e mais ${result.length - 5} resultados.` : '')
      : `Nenhum chat encontrado com o nome '${queryName}' na conta '${accountName}'. DICA: Você DEVE tentar pesquisar na outra conta (se usou 'main', tente 'personal', e vice-versa) ou usar listRecentChats.`;

    return `<RAW_TOOL_OUTPUT>\n${content}\n</RAW_TOOL_OUTPUT>`;
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
    if (!isWhatsAppConnected(accountName)) {
      return `ERRO: A conta '${accountName}' do WhatsApp não está conectada ao vivo no momento. Avise o usuário que a conta '${accountName}' está desconectada e pergunte se ele deseja conectar enviando "Conectar conta ${accountName}".`;
    }

    const allGroups = await getAllGroups(accountName);
    const query = (queryName || "").toLowerCase();
    const filtered = query
      ? allGroups.filter((g: any) => g.name && g.name.toLowerCase().includes(query))
      : allGroups;
    let content = filtered.length > 0
      ? filtered.slice(0, 5).map((g: any) => `- ${g.name} (JID: ${g.jid})`).join('\n') + (filtered.length > 5 ? `\n...e mais ${filtered.length - 5} grupos.` : '')
      : `Nenhum grupo encontrado com o nome '${query}' na conta '${accountName}'. Tente usar um nome parcial.`;
    return `<RAW_TOOL_OUTPUT source="whatsapp:groups">\n${content}\n</RAW_TOOL_OUTPUT>`;
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




export const saveContactAliasTool = tool(
  async ({ phoneNumber, alias }) => {
    try {
      let clean = phoneNumber.replace(/[^0-9]/g, '');
      if (clean.length === 10 || clean.length === 11) {
        clean = '55' + clean;
      }
      const jid = `${clean}@s.whatsapp.net`;
      await saveContact(jid, alias);
      return `Contato salvo com sucesso! A partir de agora, o número ${phoneNumber} será reconhecido como "${alias}".`;
    } catch (e: any) {
      return `Erro ao salvar contato: ${e.message}`;
    }
  },
  {
    name: "save_contact_alias",
    description: "Salva ou atualiza o nome/apelido (alias) de um contato. Use esta ferramenta quando o usuário disser 'minha mãe é o número X' ou 'anote o número do João: Y'.",
    schema: z.object({
      phoneNumber: z.string().describe("O número de telefone (idealmente com DDI e DDD, apenas números)"),
      alias: z.string().describe("O nome ou apelido para este contato (ex: 'Minha Mãe', 'João')"),
    }),
  }
);

export const addDailySummaryGroupTool = tool(
  async ({ jid, name }) => {
    try {
      await addDailySummaryGroup(jid);
      let responseMsg = `O grupo ${name || await formatJidForUser(jid)} foi adicionado à lista de grupos do resumo diário.`;
      
      const activeRoutines = await getAllActiveRoutines();
      const hasSummaryRoutine = activeRoutines.some(r => r.prompt.includes("generate_daily_summary"));
      
      if (!hasSummaryRoutine) {
        await saveRoutine(
          MASTER_NUMBER,
          "0 18 * * 1-5",
          "Use a ferramenta generate_daily_summary para buscar as mensagens das últimas 24h e gere um resumo executivo bem estruturado de todos os grupos de resumo diário para mim."
        );
        responseMsg += ` Como esta é a primeira vez que você pede para incluir um grupo, eu também já criei automaticamente uma rotina de sistema para te mandar o resumo consolidado todos os dias úteis às 18:00 no seu privado! (Se quiser mudar o horário, basta me pedir).`;
      }
      
      return responseMsg;
    } catch (e: any) {
      return `Erro ao adicionar grupo ao resumo diário: ${e.message}`;
    }
  },
  {
    name: "add_daily_summary_group",
    description: "Adiciona um grupo (JID) à lista de grupos para a rotina de resumo diário de mensagens. Use esta ferramenta quando o usuário solicitar o monitoramento, acompanhamento ou resumo diário de grupos do WhatsApp.",
    schema: z.object({
      jid: z.string().describe("O JID do grupo a ser incluído no resumo (ex: 120363xxx@g.us)"),
      name: z.string().optional().describe("Nome amigável do grupo."),
    }),
  }
);

export const removeDailySummaryGroupTool = tool(
  async ({ jid }) => {
    try {
      await removeDailySummaryGroup(jid);
      return `O grupo ${await formatJidForUser(jid)} foi removido da lista de grupos do resumo diário.`;
    } catch (e: any) {
      return `Erro ao remover grupo do resumo diário: ${e.message}`;
    }
  },
  {
    name: "remove_daily_summary_group",
    description: "Remove um grupo (JID) da lista de grupos do resumo diário.",
    schema: z.object({
      jid: z.string().describe("O JID do grupo a ser removido (ex: 120363xxx@g.us)"),
    }),
  }
);

export const listDailySummaryGroupsTool = tool(
  async () => {
    try {
      const groups = await listDailySummaryGroups();
      if (groups.length === 0) {
        return "Atualmente não há nenhum grupo na lista do resumo diário.";
      }
      const list = await Promise.all(groups.map(async g => `- ${await formatJidForUser(g.jid)} (Adicionado em: ${new Date(g.addedAt).toLocaleString('pt-BR')})`));
      return `Grupos no resumo diário atualmente:\n${list.join('\n')}`;
    } catch (e: any) {
      return `Erro ao listar grupos do resumo diário: ${e.message}`;
    }
  },
  {
    name: "list_daily_summary_groups",
    description: "Lista todos os grupos (JIDs) que estão atualmente configurados para o resumo diário.",
    schema: z.object({}),
  }
);

export const generateDailySummaryTool = tool(
  async ({ hours, filter }) => {
    try {
      const groups = await listDailySummaryGroups();
      if (groups.length === 0) {
        return "Nenhum grupo está configurado para o resumo diário. Diga ao usuário para usar o comando de adicionar grupo primeiro.";
      }
      
      const namedGroups = await Promise.all(groups.map(async g => ({
        jid: g.jid,
        name: await formatJidForUser(g.jid)
      })));

      const jids = groups.map(g => g.jid);
      let data = getMessagesForGroups(jids, hours || 24);
      
      if (filter && filter.trim()) {
        const lowerFilter = filter.toLowerCase().trim();
        const matched = namedGroups.filter(g => g.name.toLowerCase().includes(lowerFilter) || g.jid.toLowerCase().includes(lowerFilter));
        data = data.filter(g => g.groupName.toLowerCase().includes(lowerFilter) || g.chatJid.toLowerCase().includes(lowerFilter));
        
        if (data.length === 0) {
          if (matched.length > 0) {
            const checkedList = matched.map(g => `• ${g.name}`).join('\n');
            return `Verificação concluída com sucesso: Nenhum dos ${matched.length} grupos correspondentes ao filtro "${filter}" teve movimentação ou novas mensagens nas últimas ${hours || 24} horas.\nGrupos verificados:\n${checkedList}\n(Todos os grupos do filtro foram checados e estão sem novidades. Não é necessário buscar esses grupos individualmente).`;
          } else {
            return `Nenhum grupo configurado no resumo diário corresponde ao filtro "${filter}". Grupos atualmente configurados:\n${namedGroups.map(g => `• ${g.name}`).join('\n')}`;
          }
        }
      }
      
      if (data.length === 0) {
        return `Verificação concluída com sucesso: Nenhum dos ${namedGroups.length} grupos configurados no resumo diário teve movimentação nas últimas ${hours || 24} horas.\nGrupos verificados:\n${namedGroups.map(g => `• ${g.name}`).join('\n')}\n(Todos os grupos foram checados e estão silenciosos. Não é necessário buscar cada grupo individualmente).`;
      }
      
      let report = `DADOS BRUTOS DOS GRUPOS DO RESUMO DIÁRIO (ÚLTIMAS ${hours || 24} HORAS)${filter ? ` [FILTRO: "${filter}"]` : ''}:\n\n`;
      for (const group of data) {
        report += `--- GRUPO: ${group.groupName} ---\n`;
        for (const msg of group.messages) {
          report += `[${msg.date}] ${msg.senderName || msg.sender}: ${msg.content}\n`;
        }
        report += `\n`;
      }
      
      report += `INSTRUÇÃO: Faça um resumo executivo bem estruturado desses dados para o usuário. Destaque pendências, decisões e os pontos mais importantes de cada grupo.`;
      return report;
    } catch (e: any) {
      return `Erro ao gerar resumo diário dos grupos: ${e.message}`;
    }
  },
  {
    name: "generate_daily_summary",
    description: "Obtém as mensagens recentes de todos os grupos do resumo diário de forma consolidada e instantânea. Use SEMPRE esta ferramenta para resumos diários, podendo passar `filter` para focar em um grupo ou assunto específico.",
    schema: z.object({
      hours: z.number().optional().describe("Quantas horas de histórico buscar (padrão 24). Para resumos de fim de dia, use 10 ou 12. Para resumos matinais, use 24."),
      filter: z.string().optional().describe("Filtro opcional por nome do grupo ou assunto (ex: 'iFood', 'CRM', 'Condomínio'). Se omitido, busca todos os grupos configurados."),
    }),
  }
);

export const whatsappAgent = createReactAgent({
  llm: model,
  tools: [
    listRecentChatsTool, 
    getChatHistoryTool, 
    searchChatByNameTool, 
    searchGroupsTool, 
    generateDailySummaryTool,
    addDailySummaryGroupTool,
    removeDailySummaryGroupTool,
    listDailySummaryGroupsTool,
    saveContactAliasTool
  ],
  messageModifier: WHATSAPP_AGENT_PROMPT,
});

export async function whatsappAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("whatsappAgent", () => whatsappAgent, state, undefined, config);
}
