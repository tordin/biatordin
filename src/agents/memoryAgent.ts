import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { getWorkingMemoryContext } from "../memory/workingMemory.js";
import { consolidateWorkingMemorySnapshot } from "../memory/memoryConsolidator.js";
import { 
  searchVectorMemory, 
  addVectorMemory, 
  addVectorMemoryWithReconciliation,
  searchEntityMemory, 
  deleteVectorMemory, 
  reinforceMemory, 
  updateVectorMemory 
} from "../memory/vectorMemory.js";
import { getTasksForChat } from "../memory/tasks.js";
import { getSkill } from "../skills/registry.js";
import { resolveTopicId, getContextDocument, appendToContextDocument, saveContextDocument } from "../memory/contextDocuments.js";
import { checkAndCompactContextDocument } from "../memory/documentCompactor.js";

const MEMORY_PROMPT = getSkill("memoryAgent")?.detailedPrompt || "";

const MAX_MEMORY_AGENT_CALLS = 5;

function getChatContext(config?: RunnableConfig): { chatJid: string; isTrustedChat: boolean } {
  const threadId = config?.configurable?.thread_id || "";
  const chatJid = threadId.includes("_") ? threadId.split("_")[0] : threadId;
  const isTrustedChat = !!config?.configurable?.contextData?.isTrustedChat;
  return { chatJid, isTrustedChat };
}

export const readMemoryTool = tool(
  async (_params, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    logger.info("[MEMORY_AGENT] Tool readMemory chamada.");
    const content = await getWorkingMemoryContext(chatJid, isTrustedChat);
    return `<RAW_TOOL_OUTPUT>\n${content}\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "readMemory",
    description: "Lê a Memória de Trabalho Cognitiva atual da Bia (fatos vitais, recentes e consolidados).",
    schema: z.object({}),
  }
);

export const consolidateMemoryTool = tool(
  async (_params, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    logger.info(`[MEMORY_AGENT] Tool consolidateMemory chamada para chat ${chatJid} (trusted: ${isTrustedChat}).`);
    try {
      const snapshot = await consolidateWorkingMemorySnapshot(chatJid, isTrustedChat);
      return `<RAW_TOOL_OUTPUT>\nMemória consolidada com sucesso!\n\nSnapshot gerado:\n${snapshot}\n</RAW_TOOL_OUTPUT>`;
    } catch (e: any) {
      logger.error('[MEMORY_AGENT] Erro ao consolidar memória via tool:', e);
      return `<RAW_TOOL_OUTPUT>\nErro ao consolidar memória: ${e.message}\n</RAW_TOOL_OUTPUT>`;
    }
  },
  {
    name: "consolidateMemory",
    description: "Executa a síntese e consolidação imediata da memória de trabalho (sono da Bia), unificando fatos recentes em um snapshot limpo.",
    schema: z.object({}),
  }
);

export const deleteSemanticMemoryTool = tool(
  async ({ memoryId, searchQuery }, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    logger.info(`[MEMORY_AGENT] Tool deleteSemanticMemory chamada (ID: ${memoryId}, Query: "${searchQuery || ''}")`);

    if (typeof memoryId === 'number' && memoryId > 0) {
      const success = await deleteVectorMemory(memoryId);
      if (success) {
        return `<RAW_TOOL_OUTPUT>\nMemória ID ${memoryId} removida com sucesso do banco de dados.\n</RAW_TOOL_OUTPUT>`;
      }
      return `<RAW_TOOL_OUTPUT>\nFalha ao remover memória ID ${memoryId}. Verifique se o ID existe.\n</RAW_TOOL_OUTPUT>`;
    }

    if (searchQuery && searchQuery.trim()) {
      const results = await searchVectorMemory(searchQuery.trim(), 1, chatJid, isTrustedChat);
      if (results && results.length > 0) {
        const target = results[0];
        await deleteVectorMemory(target.id);
        return `<RAW_TOOL_OUTPUT>\nMemória ID ${target.id} ("${target.content}") encontrada e removida com sucesso.\n</RAW_TOOL_OUTPUT>`;
      }
      return `<RAW_TOOL_OUTPUT>\nNenhuma memória correspondente encontrada para exclusão com a busca "${searchQuery}".\n</RAW_TOOL_OUTPUT>`;
    }

    return `<RAW_TOOL_OUTPUT>\nInforme o memoryId ou a searchQuery para localizar e excluir a memória.\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "deleteSemanticMemory",
    description: "Apaga uma memória específica do banco relacional e vetorial pelo ID ou por busca do texto.",
    schema: z.object({
      memoryId: z.number().optional().describe("O ID numérico da memória a ser apagada (retornado pelas buscas)."),
      searchQuery: z.string().optional().describe("Texto ou palavras-chave para encontrar e apagar a memória correspondente.")
    }),
  }
);

export const searchSemanticMemoryTool = tool(
  async ({ query, objective }, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    logger.info(`[MEMORY_AGENT] Executando busca semântica RAG para a query: "${query}"`);

    const results = await searchVectorMemory(query, 5, chatJid, isTrustedChat);

    // Reforço cognitivo automático nos IDs encontrados
    if (results.length > 0) {
      const ids = results.map(r => r.id);
      reinforceMemory(ids).catch(e => logger.error('[MEMORY_AGENT] Falha no reforço cognitivo:', e));
    }

    let searchSummary =
      results.length > 0
        ? results
            .map(
              (r, i) =>
                `${i + 1}. [ID: ${r.id}] [${r.category.toUpperCase()}] (Importância: ${r.importance}, Data: ${r.createdAt}): ${r.content}`
            )
            .join("\n")
        : "Nenhuma memória semântica correspondente foi encontrada no banco.";

    if (objective && results.length > 0) {
      try {
        const filterResponse = await model.invoke([
          new SystemMessage(
            `Você é um extrator de informações de memória.\n` +
            `Extraia e formate qualquer trecho das MEMÓRIAS BRUTAS que responda ou se relacione com o seguinte TEMA/OBJETIVO: "${objective}".\n` +
            `Se houver memórias que tratem do assunto (mesmo que com palavras ligeiramente diferentes ou de forma parcial), MANTENHA-AS.\n` +
            `Descarte apenas assuntos completamente alheios ou irrelevantes.\n` +
            `Se nenhuma memória tiver qualquer relação com o objetivo, responda apenas: "Nenhuma informação relevante para o objetivo encontrada."`
          ),
          new HumanMessage(`MEMÓRIAS BRUTAS:\n${searchSummary}`)
        ]);
        searchSummary = typeof filterResponse.content === 'string' ? filterResponse.content : JSON.stringify(filterResponse.content);
      } catch (err: any) {
        logger.error(`[LLM Filter Error] searchSemanticMemoryTool: ${err.message}`);
      }
    }

    return `<RAW_TOOL_OUTPUT>\nResultados da busca semântica RAG:\n\n${searchSummary}\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "searchSemanticMemory",
    description:
      "Realiza uma busca semântica RAG por similaridade vetorial (sqlite-vec) em todas as memórias passadas, anotações, combinados e preferências anotadas.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "A pergunta ou os termos-chave contextuais para a busca semântica (ex: 'presente aniversario irmao maio', 'marca racao cachorro', 'combinado viagem')"
        ),
      objective: z
        .string()
        .describe(
          "OBRIGATÓRIO: O tema, a pergunta ou o fato desejado a ser extraído destas memórias (ex: 'moedor JMax ajuste espresso', 'tamanho sapato cecilia'). Evite metalinguagem ou perguntas sobre a localização da gravação."
        ),
    }),
  }
);

export const storeSemanticMemoryTool = tool(
  async ({ content, category, importance }, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    const activeTopicTitle =
      config?.configurable?.contextData?.activeTopicTitle ||
      config?.configurable?.contextData?.active_topic_title ||
      "";
    const activeTopicId =
      config?.configurable?.contextData?.activeTopicId ||
      config?.configurable?.contextData?.active_topic_id ||
      undefined;

    let finalContent = content;
    if (activeTopicTitle && finalContent) {
      const topicWords = activeTopicTitle
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w.length > 2);
      const contentLower = finalContent.toLowerCase();
      const hasTopicReference = topicWords.some((word: string) =>
        contentLower.includes(word)
      );
      if (!hasTopicReference) {
        finalContent = `${activeTopicTitle}: ${finalContent}`;
        logger.info(
          `[MEMORY_AGENT] Auto-enrich: memória prefixada com assunto ativo "${activeTopicTitle}"`
        );
      }
    }

    const finalCategory = category || "anotacao";
    const finalImportance = typeof importance === 'number' ? importance : (finalCategory === 'perfil' ? 1.0 : 0.5);

    logger.info(
      `[MEMORY_AGENT] Salvando nova memória cognitiva RAG com reconciliação: "${finalContent}" (Categoria: ${finalCategory}, Importância: ${finalImportance})`
    );
    const metadata = activeTopicId ? { topicId: activeTopicId } : undefined;
    const result = await addVectorMemoryWithReconciliation(
      finalContent,
      finalCategory,
      chatJid,
      metadata,
      finalImportance,
      isTrustedChat
    );

    let responseMsg = `Memória semântica gravada com sucesso no SQLite (ID: ${result.memoryId ?? 'nenhum'}, Importância: ${finalImportance}).`;
    if (result.verdict && result.verdict.decisions.length > 0) {
      const actions = result.verdict.decisions.map(d => `${d.candidateId}: ${d.action} (${d.reason})`).join("; ");
      responseMsg += ` [Reconciliação Semântica: ${actions}]`;
    }
    return responseMsg;
  },
  {
    name: "storeSemanticMemory",
    description:
      "Armazena um fato específico, combinado, anotação ou preferência na memória cognitiva RAG (vetorizada via sqlite-vec).",
    schema: z.object({
      content: z
        .string()
        .describe(
          "O texto da memória a ser salva com contexto completo (ex: 'Combinei de comprar um relógio smartwatch de presente de aniversário para o meu irmão em maio')"
        ),
      category: z
        .string()
        .optional()
        .describe(
          "Categoria da memória: 'perfil', 'fato', 'preferencia', 'combinado', 'anotacao', 'compra'"
        ),
      importance: z
        .number()
        .min(0.0)
        .max(1.0)
        .optional()
        .describe(
          "Importância/saliência do fato de 0.0 a 1.0. Guia: 1.0 para fatos vitais de família/perfil (permanentes); 0.7-0.8 para preferências consolidadas; 0.3-0.5 para notas pontuais/eventos transitórios."
        ),
    }),
  }
);

export const searchEventSummaryTool = tool(
  async ({ keywords }, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);

    logger.info(
      `[MEMORY_AGENT] Executando busca ampla por entidade: [${keywords.join(", ")}]`
    );

    // 1. Busca ampla por texto nas memórias vetoriais
    const entityResults = await searchEntityMemory(
      keywords,
      chatJid,
      20,
      isTrustedChat
    );

    if (entityResults.length > 0) {
      const ids = entityResults.map(r => r.id);
      reinforceMemory(ids).catch(e => logger.error('[MEMORY_AGENT] Falha no reforço cognitivo em busca por entidade:', e));
    }

    const memorySummary =
      entityResults.length > 0
        ? entityResults
            .map(
              (r, i) =>
                `${i + 1}. [ID: ${r.id}] [${r.category.toUpperCase()}] (Importância: ${r.importance}, Data: ${r.createdAt}): ${r.content}`
            )
            .join("\n")
        : "Nenhuma memória encontrada para essas palavras-chave.";

    // 2. Busca tarefas pendentes com keywords no título
    let tasksSummary = "";
    try {
      const allTasks = await getTasksForChat(chatJid, "pending");
      const relevantTasks = allTasks.filter((t) =>
        keywords.some(
          (kw) =>
            t.title.toLowerCase().includes(kw.toLowerCase()) ||
            t.category.toLowerCase().includes(kw.toLowerCase())
        )
      );
      if (relevantTasks.length > 0) {
        tasksSummary =
          "\n\nTAREFAS PENDENTES RELACIONADAS:\n" +
          relevantTasks
            .map(
              (t, i) =>
                `${i + 1}. [${t.urgency}] ${t.title} (Categoria: ${t.category}${t.dueDate ? `, Prazo: ${t.dueDate}` : ""})`
            )
            .join("\n");
      } else {
        tasksSummary =
          "\n\nTAREFAS PENDENTES RELACIONADAS: Nenhuma tarefa pendente encontrada para esse evento.";
      }
    } catch (taskErr) {
      logger.warn(
        "[MEMORY_AGENT] Erro ao buscar tarefas relacionadas:",
        taskErr
      );
      tasksSummary = "\n\nTAREFAS: Não foi possível consultar as tarefas.";
    }

    // 3. Busca semântica complementar com as keywords em frase
    let semanticExtra = "";
    try {
      const semanticResults = await searchVectorMemory(
        keywords.join(" "),
        10,
        chatJid,
        isTrustedChat
      );
      const entityIds = new Set(entityResults.map((r) => r.id));
      const newResults = semanticResults.filter((r) => !entityIds.has(r.id));
      if (newResults.length > 0) {
        const extraIds = newResults.map(r => r.id);
        reinforceMemory(extraIds).catch(e => logger.error('[MEMORY_AGENT] Falha no reforço complementar:', e));

        semanticExtra =
          "\n\nMEMÓRIAS ADICIONAIS (busca semântica):\n" +
          newResults
            .map(
              (r, i) =>
                `${i + 1}. [ID: ${r.id}] [${r.category.toUpperCase()}] (Importância: ${r.importance}, Data: ${r.createdAt}): ${r.content}`
            )
            .join("\n");
      }
    } catch (semErr) {
      logger.warn(
        "[MEMORY_AGENT] Erro na busca semântica complementar:",
        semErr
      );
    }

    return `<RAW_TOOL_OUTPUT>\nMEMÓRIAS ENCONTRADAS:\n\n${memorySummary}${semanticExtra}${tasksSummary}\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "searchEventSummary",
    description:
      "Busca AMPLA por entidade/evento/projeto. Use quando o usuário pedir 'tudo sobre X', 'me fala tudo da festa', 'lista tudo que sabe sobre o aniversário'. Combina busca textual com tarefas pendentes para montar um painel completo.",
    schema: z.object({
      keywords: z
        .array(z.string())
        .describe(
          "Lista de palavras-chave do evento/projeto (ex: ['festa', 'cecilia', 'aniversario'])"
        ),
    }),
  }
);

export const getContextDocumentTool = tool(
  async ({ topicTitleOrId }, config) => {
    const { chatJid } = getChatContext(config);
    const { topicId } = await resolveTopicId(chatJid, topicTitleOrId);
    const doc = await getContextDocument(topicId);
    if (!doc) {
      return `<RAW_TOOL_OUTPUT>\nNenhum documento encontrado para o tópico "${topicTitleOrId}". Você pode criá-hor chamando overwrite_context_document ou append_context_document.\n</RAW_TOOL_OUTPUT>`;
    }
    return `<RAW_TOOL_OUTPUT>\n=== DOCUMENTO VIVO: ${doc.title} ===\n\n${doc.content}\n\n(Tamanho: ${doc.content.length}/${doc.max_characters})\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "get_context_document",
    description: "Retorna o documento Markdown completo (todas as regras e histórico) de um assunto.",
    schema: z.object({ topicTitleOrId: z.string().describe("Título ou ID do tópico (ex: 'Cardápios semanais')") })
  }
);

export const appendContextDocumentTool = tool(
  async ({ topicTitleOrId, text }, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    const { topicId, title } = await resolveTopicId(chatJid, topicTitleOrId);
    await appendToContextDocument(topicId, title, text);
    await checkAndCompactContextDocument(topicId, chatJid, isTrustedChat);
    return `<RAW_TOOL_OUTPUT>\nTexto adicionado com sucesso ao documento "${title}".\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "append_context_document",
    description: "Concatena texto/diário/histórico ao final do documento vivo do tópico.",
    schema: z.object({ 
      topicTitleOrId: z.string().describe("Título ou ID do tópico"),
      text: z.string().describe("Texto Markdown a ser concatenado no final do documento")
    })
  }
);

export const overwriteContextDocumentTool = tool(
  async ({ topicTitleOrId, content }, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    const { topicId, title } = await resolveTopicId(chatJid, topicTitleOrId);
    await saveContextDocument(topicId, title, content);
    await checkAndCompactContextDocument(topicId, chatJid, isTrustedChat);
    return `<RAW_TOOL_OUTPUT>\nDocumento "${title}" sobrescrito com sucesso.\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "overwrite_context_document",
    description: "Substitui todo o conteúdo do documento vivo do tópico. Use apenas se precisar reescrever regras no meio do texto.",
    schema: z.object({ 
      topicTitleOrId: z.string().describe("Título ou ID do tópico"),
      content: z.string().describe("Novo conteúdo completo do documento em Markdown")
    })
  }
);

export const compactContextDocumentTool = tool(
  async ({ topicTitleOrId }, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    const { topicId, title } = await resolveTopicId(chatJid, topicTitleOrId);
    await checkAndCompactContextDocument(topicId, chatJid, isTrustedChat, true);
    return `<RAW_TOOL_OUTPUT>\nSolicitação de compactação processada para "${title}".\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "compact_context_document",
    description: "Força a sumarização do documento imediatamente, expurgando trivialidades pro RAG.",
    schema: z.object({ topicTitleOrId: z.string().describe("Título ou ID do tópico") })
  }
);

export const memoryAgent = createReactAgent({
  llm: model,
  tools: [
    readMemoryTool,
    consolidateMemoryTool,
    deleteSemanticMemoryTool,
    searchSemanticMemoryTool,
    storeSemanticMemoryTool,
    searchEventSummaryTool,
    getContextDocumentTool,
    appendContextDocumentTool,
    overwriteContextDocumentTool,
    compactContextDocumentTool
  ],
  messageModifier: MEMORY_PROMPT,
});

export async function memoryAgentNode(
  state: typeof AgentState.State,
  config?: RunnableConfig
) {
  const threadId = config?.configurable?.thread_id || "";
  logger.logAgentStart("memoryAgent", threadId, state.contextData);

  // Limite de segurança de chamadas
  const executionLog = state.contextData.executionLog || [];
  const memoryAgentCallCount = executionLog.filter(
    (e: string) => e === "memoryAgent"
  ).length;
  if (memoryAgentCallCount >= MAX_MEMORY_AGENT_CALLS) {
    logger.warn(
      `[MEMORY_AGENT] Limite de ${MAX_MEMORY_AGENT_CALLS} chamadas atingido (${memoryAgentCallCount} anteriores). Pulando LLM.`
    );
    return {
      messages: [
        new AIMessage(
          "Limite de chamadas ao agente de memória atingido nesta sessão."
        ),
      ],
      nextAgent: "supervisor",
      contextData: { newExecution: "memoryAgent" },
    };
  }

  return safeAgentNode(
    "memoryAgent",
    () => memoryAgent,
    state,
    undefined,
    config
  );
}
