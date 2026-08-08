import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { getMemory, deleteFromMemory } from "../memory/coreMemory.js";
import { searchVectorMemory, addVectorMemory, searchEntityMemory } from "../memory/vectorMemory.js";
import { getTasksForChat } from "../memory/tasks.js";
import { getSkill } from "../skills/registry.js";

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
    const content = getMemory(chatJid, isTrustedChat);
    return `<RAW_TOOL_OUTPUT>\n${content}\n</RAW_TOOL_OUTPUT>`;
  },
  {
    name: "readMemory",
    description: "Lê o conteúdo principal/estruturado do arquivo de memória da Bia.",
    schema: z.object({}),
  }
);

export const deleteFromCoreMemoryTool = tool(
  async ({ exactTextToRemove }, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    logger.info(`[MEMORY_AGENT] Tool deleteFromCoreMemory chamada para o texto: "${exactTextToRemove.substring(0, 30)}..."`);
    
    const success = deleteFromMemory(chatJid, isTrustedChat, exactTextToRemove);
    if (success) {
      return `<RAW_TOOL_OUTPUT>\nTexto removido da memória core com sucesso.\n</RAW_TOOL_OUTPUT>`;
    } else {
      return `<RAW_TOOL_OUTPUT>\nTexto não encontrado na memória core. Verifique se o trecho exato foi fornecido.\n</RAW_TOOL_OUTPUT>`;
    }
  },
  {
    name: "deleteFromCoreMemory",
    description: "Apaga um trecho de texto exato da memória core (bia_memory.md). Você deve ler a memória antes para copiar o texto exato.",
    schema: z.object({
      exactTextToRemove: z.string().describe("O texto EXATO a ser removido da memória, exatamente como retornado por readMemory.")
    }),
  }
);

export const searchSemanticMemoryTool = tool(
  async ({ query, objective }, config) => {
    const { chatJid, isTrustedChat } = getChatContext(config);
    logger.info(`[MEMORY_AGENT] Executando busca semântica RAG para a query: "${query}"`);

    const results = await searchVectorMemory(query, 5, chatJid, isTrustedChat);
    let searchSummary =
      results.length > 0
        ? results
            .map(
              (r, i) =>
                `${i + 1}. [${r.category.toUpperCase()}] (${r.createdAt}): ${r.content}`
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
  async ({ content, category }, config) => {
    const { chatJid } = getChatContext(config);
    const activeTopicTitle =
      config?.configurable?.contextData?.activeTopicTitle ||
      config?.configurable?.contextData?.active_topic_title ||
      "";
    const activeTopicId =
      config?.configurable?.contextData?.activeTopicId ||
      config?.configurable?.contextData?.active_topic_id ||
      undefined;

    // Auto-enrich: se o assunto ativo é sobre um evento/projeto e o conteúdo não o menciona,
    // prefixa automaticamente com o contexto do assunto para evitar memórias órfãs.
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

    logger.info(
      `[MEMORY_AGENT] Salvando nova memória semântica RAG: "${finalContent}"`
    );
    const metadata = activeTopicId ? { topicId: activeTopicId } : undefined;
    const memId = await addVectorMemory(finalContent, finalCategory, chatJid, metadata);
    return `Memória semântica gravada com sucesso no SQLite (ID: ${memId}).`;
  },
  {
    name: "storeSemanticMemory",
    description:
      "Armazena um fato específico, combinado, anotação ou preferência na memória semântica de longo prazo em SQLite (vetorizado via sqlite-vec).",
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
          "Categoria da memória: 'fato', 'preferencia', 'combinado', 'anotacao', 'compra'"
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
    const memorySummary =
      entityResults.length > 0
        ? entityResults
            .map(
              (r, i) =>
                `${i + 1}. [${r.category.toUpperCase()}] (${r.createdAt}): ${r.content}`
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
      // Filter out duplicates already in entityResults
      const entityIds = new Set(entityResults.map((r) => r.id));
      const newResults = semanticResults.filter((r) => !entityIds.has(r.id));
      if (newResults.length > 0) {
        semanticExtra =
          "\n\nMEMÓRIAS ADICIONAIS (busca semântica):\n" +
          newResults
            .map(
              (r, i) =>
                `${i + 1}. [${r.category.toUpperCase()}] (${r.createdAt}): ${r.content}`
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

const memoryAgent = createReactAgent({
  llm: model,
  tools: [
    readMemoryTool,
    deleteFromCoreMemoryTool,
    searchSemanticMemoryTool,
    storeSemanticMemoryTool,
    searchEventSummaryTool,
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
