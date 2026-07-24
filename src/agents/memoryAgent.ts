import { SystemMessage, AIMessage, HumanMessage, RemoveMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { AgentState } from "./state.js";
import { modelFlash as model, modelFlashStructured } from "../llm/model.js";
import { sanitizeMessagesForModel, buildRecencyAnchoredHistory } from "../utils/sanitize.js";
import { cleanMarkdownForWhatsApp } from "../transport/formatters.js";
import { logger } from "../utils/logger.js";
import { getMemory, updateMemory } from "../memory/coreMemory.js";
import { searchVectorMemory, addVectorMemory, listVectorMemories, searchEntityMemory } from "../memory/vectorMemory.js";
import { getTasksForChat } from "../memory/tasks.js";

import { getSkill } from "../skills/registry.js";

const MEMORY_PROMPT = getSkill("memoryAgent")?.detailedPrompt || "";

const MAX_MEMORY_AGENT_CALLS = 5;

/**
 * Ferramentas de Memória da Bia (Estática + RAG Vetorial em SQLite)
 */
const readMemoryTool = {
  type: "function" as const,
  function: {
    name: "readMemory",
    description: "Lê o conteúdo principal/estruturado do arquivo de memória da Bia.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  }
};

const searchSemanticMemoryTool = {
  type: "function" as const,
  function: {
    name: "searchSemanticMemory",
    description: "Realiza uma busca semântica RAG por similaridade vetorial (sqlite-vec) em todas as memórias passadas, anotações, combinados e preferências anotadas.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A pergunta ou os termos-chave contextuais para a busca semântica (ex: 'presente aniversario irmao maio', 'marca racao cachorro', 'combinado viagem')"
        }
      },
      required: ["query"]
    }
  }
};

const storeSemanticMemoryTool = {
  type: "function" as const,
  function: {
    name: "storeSemanticMemory",
    description: "Armazena um fato específico, combinado, anotação ou preferência na memória semântica de longo prazo em SQLite (vetorizado via sqlite-vec).",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "O texto da memória a ser salva com contexto completo (ex: 'Combinei de comprar um relógio smartwatch de presente de aniversário para o meu irmão em maio')"
        },
        category: {
          type: "string",
          description: "Categoria da memória: 'fato', 'preferencia', 'combinado', 'anotacao', 'compra'"
        }
      },
      required: ["content"]
    }
  }
};

const searchEventSummaryTool = {
  type: "function" as const,
  function: {
    name: "searchEventSummary",
    description: "Busca AMPLA por entidade/evento/projeto. Use quando o usuário pedir 'tudo sobre X', 'me fala tudo da festa', 'lista tudo que sabe sobre o aniversário'. Combina busca textual com tarefas pendentes para montar um painel completo.",
    parameters: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Lista de palavras-chave do evento/projeto (ex: ['festa', 'cecilia', 'aniversario'])"
        }
      },
      required: ["keywords"]
    }
  }
};

export async function memoryAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id || "";
  const chatJid = state.contextData.chatJid || "unknown";
  const isTrustedChat = !!state.contextData.isTrustedChat;
  const activeTopicTitle = state.contextData.active_topic_title || "";
  
  logger.logAgentStart("memoryAgent", threadId, state.contextData);

  // Limite de segurança de chamadas
  const executionLog = state.contextData.executionLog || [];
  const memoryAgentCallCount = executionLog.filter(e => e === "memoryAgent").length;
  if (memoryAgentCallCount >= MAX_MEMORY_AGENT_CALLS) {
    logger.warn(`[MEMORY_AGENT] Limite de ${MAX_MEMORY_AGENT_CALLS} chamadas atingido (${memoryAgentCallCount} anteriores). Pulando LLM.`);
    return {
      messages: [new ToolMessage({
        content: "Limite de chamadas ao agente de memória atingido nesta sessão.",
        name: "memoryAgent",
        tool_call_id: "memory"
      })],
      nextAgent: "supervisor",
      contextData: { newExecution: "memoryAgent" }
    };
  }

  try {
    const currentMemory = getMemory(chatJid, isTrustedChat);

    const topicContextHint = activeTopicTitle
      ? `\n\n[ASSUNTO ATIVO DA CONVERSA]: "${activeTopicTitle}"\n` +
        `REGRA CRÍTICA DE CONTEXTUALIZAÇÃO: Ao salvar qualquer memória com storeSemanticMemory, SEMPRE inclua o assunto/evento ativo como contexto no texto da memória. ` +
        `Por exemplo, se o assunto ativo é "Festa da Cecilia" e o usuário diz "anote que João confirmou", grave: "Festa da Cecilia: João confirmou presença". ` +
        `NUNCA grave fatos isolados como "João confirmou" sem referência ao assunto.`
      : "";

    const systemPrompt = new SystemMessage(
      `${MEMORY_PROMPT}\n\n[MEMÓRIA DE PERFIL DA BIA]:\n${currentMemory}${topicContextHint}`
    );

    const cleanHistory = state.messages.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
    const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);
    const messagesForModel = [systemPrompt, ...buildRecencyAnchoredHistory(sanitizedHistory, 12)];

    // Modelo com ferramentas RAG vetoriais e leitura estática
    const memoryModel = model.bindTools([storeSemanticMemoryTool, readMemoryTool, searchSemanticMemoryTool, searchEventSummaryTool]);

    const response = await memoryModel.invoke(messagesForModel, {
      metadata: { agentName: "memoryAgent", threadId }
    });

    // Se o modelo acionou uma ou mais ferramentas
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolResultMsgs: ToolMessage[] = [];
      let isStoreMemory = false;
      let primarySearchSummary = "";

      for (const toolCall of response.tool_calls) {
        if (toolCall.name === "searchSemanticMemory") {
          const query = (toolCall.args as any)?.query || "";
          logger.info(`[MEMORY_AGENT] Executando busca semântica RAG para a query: "${query}"`);

          const results = await searchVectorMemory(query, 5, chatJid, isTrustedChat);
          const searchSummary = results.length > 0
            ? results.map((r, i) => `${i + 1}. [${r.category.toUpperCase()}] (${r.createdAt}): ${r.content}`).join("\n")
            : "Nenhuma memória semântica correspondente foi encontrada no banco.";

          primarySearchSummary = searchSummary;

          toolResultMsgs.push(new ToolMessage({
            content: `Resultados da busca semântica RAG:\n\n${searchSummary}`,
            name: "searchSemanticMemory",
            tool_call_id: toolCall.id || "search_semantic"
          }));
        } else if (toolCall.name === "storeSemanticMemory") {
          isStoreMemory = true;
          let { content, category = "anotacao" } = (toolCall.args as any) || {};

          // Auto-enrich: se o assunto ativo é sobre um evento/projeto e o conteúdo não o menciona,
          // prefixa automaticamente com o contexto do assunto para evitar memórias órfãs.
          if (activeTopicTitle && content) {
            const topicWords = activeTopicTitle.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
            const contentLower = content.toLowerCase();
            const hasTopicReference = topicWords.some((word: string) => contentLower.includes(word));
            if (!hasTopicReference) {
              content = `${activeTopicTitle}: ${content}`;
              logger.info(`[MEMORY_AGENT] Auto-enrich: memória prefixada com assunto ativo "${activeTopicTitle}"`);
            }
          }

          logger.info(`[MEMORY_AGENT] Salvando nova memória semântica RAG: "${content}"`);

          const memId = await addVectorMemory(content, category, chatJid);

          toolResultMsgs.push(new ToolMessage({
            content: `Memória semântica gravada com sucesso no SQLite (ID: ${memId}).`,
            name: "storeSemanticMemory",
            tool_call_id: toolCall.id || "store_semantic"
          }));
        } else if (toolCall.name === "searchEventSummary") {
          const keywords: string[] = (toolCall.args as any)?.keywords || [];
          logger.info(`[MEMORY_AGENT] Executando busca ampla por entidade: [${keywords.join(', ')}]`);

          // 1. Busca ampla por texto nas memórias vetoriais
          const entityResults = await searchEntityMemory(keywords, chatJid, 20, isTrustedChat);
          const memorySummary = entityResults.length > 0
            ? entityResults.map((r, i) => `${i + 1}. [${r.category.toUpperCase()}] (${r.createdAt}): ${r.content}`).join("\n")
            : "Nenhuma memória encontrada para essas palavras-chave.";

          // 2. Busca tarefas pendentes com keywords no título
          let tasksSummary = "";
          try {
            const allTasks = await getTasksForChat(chatJid, 'pending');
            const relevantTasks = allTasks.filter(t => 
              keywords.some(kw => t.title.toLowerCase().includes(kw.toLowerCase()) || t.category.toLowerCase().includes(kw.toLowerCase()))
            );
            if (relevantTasks.length > 0) {
              tasksSummary = "\n\nTAREFAS PENDENTES RELACIONADAS:\n" + relevantTasks.map((t, i) => 
                `${i + 1}. [${t.urgency}] ${t.title} (Categoria: ${t.category}${t.dueDate ? `, Prazo: ${t.dueDate}` : ''})`
              ).join("\n");
            } else {
              tasksSummary = "\n\nTAREFAS PENDENTES RELACIONADAS: Nenhuma tarefa pendente encontrada para esse evento.";
            }
          } catch (taskErr) {
            logger.warn('[MEMORY_AGENT] Erro ao buscar tarefas relacionadas:', taskErr);
            tasksSummary = "\n\nTAREFAS: Não foi possível consultar as tarefas.";
          }

          // 3. Busca semântica complementar com as keywords em frase
          let semanticExtra = "";
          try {
            const semanticResults = await searchVectorMemory(keywords.join(' '), 10, chatJid, isTrustedChat);
            // Filter out duplicates already in entityResults
            const entityIds = new Set(entityResults.map(r => r.id));
            const newResults = semanticResults.filter(r => !entityIds.has(r.id));
            if (newResults.length > 0) {
              semanticExtra = "\n\nMEMÓRIAS ADICIONAIS (busca semântica):\n" + newResults.map((r, i) => 
                `${i + 1}. [${r.category.toUpperCase()}] (${r.createdAt}): ${r.content}`
              ).join("\n");
            }
          } catch (semErr) {
            logger.warn('[MEMORY_AGENT] Erro na busca semântica complementar:', semErr);
          }

          const fullSummary = `MEMÓRIAS ENCONTRADAS:\n\n${memorySummary}${semanticExtra}${tasksSummary}`;
          primarySearchSummary = fullSummary;

          toolResultMsgs.push(new ToolMessage({
            content: fullSummary,
            name: "searchEventSummary",
            tool_call_id: toolCall.id || "search_entity"
          }));
        } else if (toolCall.name === "readMemory") {
          logger.info("[MEMORY_AGENT] Tool readMemory chamada.");

          toolResultMsgs.push(new ToolMessage({
            content: currentMemory,
            name: "readMemory",
            tool_call_id: toolCall.id || "read"
          }));
        }
      }

      const followUpMessages = [...messagesForModel, response, ...toolResultMsgs];
      const followUpResponse = await memoryModel.invoke(followUpMessages, {
        metadata: { agentName: "memoryAgent", threadId, step: "tool-followup" }
      });

      const finalResponse = typeof followUpResponse.content === "string"
        ? cleanMarkdownForWhatsApp(followUpResponse.content)
        : primarySearchSummary || "Operação de memória concluída.";

      if (isStoreMemory) {
        return {
          messages: [new ToolMessage({
            content: `Memória salva com sucesso no banco RAG. Mensagem de confirmação:\n\n${finalResponse}`,
            name: "memoryAgent",
            tool_call_id: response.tool_calls[0].id || "store_semantic"
          })],
          nextAgent: "supervisor",
          contextData: { newExecution: "memoryAgent" }
        };
      }

      return {
        messages: [new AIMessage(finalResponse)],
        nextAgent: "supervisor",
        contextData: { newExecution: "memoryAgent" }
      };
    }

    // Se nenhuma ferramenta foi chamada, procede para a atualização estruturada de perfil (escreve no Markdown e sincroniza no RAG)
    const structuredModel = modelFlashStructured.withStructuredOutput(z.object({
      newMemoryContent: z.string().describe("O conteúdo atualizado completo da memória de perfil em markdown"),
      responseToUser: z.string().describe("Mensagem de confirmação para o usuário")
    }), { name: "MemoryAgentDecision" });

    const parsed = await structuredModel.invoke(messagesForModel, {
      metadata: { agentName: "memoryAgent", threadId, step: "write" }
    });

    let memoryChanged = false;

    if (parsed.newMemoryContent.trim() !== currentMemory.trim()) {
      updateMemory(chatJid, isTrustedChat, parsed.newMemoryContent);
      logger.info("[MEMORY_AGENT] Memória alterada. Gravando no disco.");
      memoryChanged = true;
    } else if (parsed.responseToUser && parsed.responseToUser.trim()) {
      // Fallback: conteúdo inalterado mas LLM gerou resposta — salva no RAG como anotação
      await addVectorMemory(parsed.responseToUser, "anotacao", chatJid);
      logger.info("[MEMORY_AGENT] Memória inalterada, mas resposta do usuário salva como anotação RAG.");
    } else {
      logger.info("[MEMORY_AGENT] Memória inalterada. Pulando gravação.");
    }

    const finalResponse = cleanMarkdownForWhatsApp(parsed.responseToUser);

    return {
      messages: [new ToolMessage({
        content: `A memória foi atualizada com sucesso. Mensagem sugerida para o usuário:\n\n${finalResponse}`,
        name: "memoryAgent",
        tool_call_id: "memory"
      })],
      nextAgent: "supervisor",
      contextData: { newExecution: "memoryAgent" }
    };
  } catch (error: any) {
    logger.error("[MEMORY_AGENT ERROR]", error);
    return {
      messages: [new AIMessage("Desculpe, tive um probleminha ao tentar acessar minhas anotações. Pode tentar novamente?")],
      nextAgent: "supervisor",
      contextData: { newExecution: "memoryAgent" }
    };
  }
}
