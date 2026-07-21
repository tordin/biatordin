import { SystemMessage, AIMessage, HumanMessage, RemoveMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { AgentState } from "./state.js";
import { modelPro as model } from "../llm/model.js";
import { sanitizeMessagesForModel } from "../utils/sanitize.js";
import { cleanMarkdownForWhatsApp } from "../transport/formatters.js";
import { logger } from "../utils/logger.js";
import { getMemory, updateMemory } from "../memory/coreMemory.js";

const MEMORY_PROMPT = 
  "Você é a Bia, uma assistente virtual, atuando agora como a Especialista em Memória Interna.\n" +
  "Sua função é ler a sua memória atual, entender a solicitação do usuário e decidir qual deve ser o novo conteúdo da sua memória.\n" +
  "Sua memória é um arquivo Markdown privado, onde você anota fatos sobre o usuário, preferências, listas de compras, ideias, tarefas e qualquer outra coisa que ele peça para você lembrar.\n\n" +
  "PERSONA E IDENTIDADE FEMININA (Crucial):\n" +
  "- Você é a Bia, uma mulher e assistente virtual. Nunca se refira a si mesma no masculino.\n" +
  "- Use SEMPRE adjetivos, particípios e flexões de gênero no feminino ao falar de si mesma ou de suas ações (ex: diga 'sincera', 'obrigada', 'atenta', 'pronta', 'preocupada', 'cansada', 'ocupada', 'confiante').\n" +
  "- NUNCA use palavras masculinas para si mesma como 'sincero', 'obrigado', 'atento', 'pronto', 'preocupado', 'cansado', 'ocupado'.\n\n" +
  "REGRAS PARA A MEMÓRIA:\n" +
  "- Mantenha a memória bem organizada com títulos Markdown (ex: # Preferências, # Lista de Compras, # Gerenciamento de Tarefas).\n" +
  "- Adicione, modifique ou remova itens conforme solicitado pelo usuário.\n" +
  "- GERENCIAMENTO DE TAREFAS: Ao anotar tarefas, utilize listas com checkboxes de markdown (- [ ] pendente, - [x] concluído). Inclua contexto sobre urgência (ex: Urgência: Alta/Média/Baixa) e datas/prazos (ex: Data: 20/07). Sempre atualize o status (marcando com 'x' ou apagando) quando o usuário informar que concluiu.\n" +
  "- Tente manter as informações concisas mas úteis para o futuro.\n\n" +
  "Lembre-se de ser natural e amigável na sua mensagem para o usuário, seguindo o estilo do WhatsApp (sem formatação complexa).";

const MAX_MEMORY_AGENT_CALLS = 5;

/**
 * Tool definition for readMemory.
 * The LLM calls this when it wants to READ the current memory content
 * (e.g. the user asks "what's in your memory?", "list my tasks", etc.).
 * When NOT called, the LLM proceeds to structured output for WRITE operations.
 */
const readMemoryTool = {
  type: "function" as const,
  function: {
    name: "readMemory",
    description: "Lê o conteúdo completo da memória da Bia. Use quando o usuário perguntar o que está anotado, quais informações você tem sobre ele, ou quiser consultar algum dado específico da memória.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  }
};

export async function memoryAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id || "";
  const chatJid = state.contextData.chatJid || "unknown";
  const isTrustedChat = !!state.contextData.isTrustedChat;
  
  logger.logAgentStart("memoryAgent", threadId, state.contextData);

  // Enforce call limit: skip LLM invocation if memoryAgent already called 5+ times
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

    // Build system prompt with current memory content
    const systemPrompt = new SystemMessage(
      `${MEMORY_PROMPT}\n\n[MEMÓRIA ATUAL DA BIA]:\n${currentMemory}`
    );

    const cleanHistory = state.messages.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
    const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);
    const messagesForModel = [systemPrompt, ...sanitizedHistory.slice(-5)];

    // Step 1: Invoke model with bindTools — LLM decides: call readMemory or structured output
    const memoryModel = model.bindTools([readMemoryTool]);

    const response = await memoryModel.invoke(messagesForModel, {
      metadata: { agentName: "memoryAgent", threadId }
    });

    // Step 2: If LLM called readMemory tool → feed result back and get natural response
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolCall = response.tool_calls[0];
      if (toolCall.name === "readMemory") {
        logger.info("[MEMORY_AGENT] Tool readMemory chamada. Retornando conteúdo da memória para o LLM.");

        // Feed the tool result back to the model so it can formulate a natural response
        const toolResultMsg = new ToolMessage({
          content: currentMemory,
          name: "readMemory",
          tool_call_id: toolCall.id || "read"
        });

        const followUpMessages = [...messagesForModel, response, toolResultMsg];
        const followUpResponse = await memoryModel.invoke(followUpMessages, {
          metadata: { agentName: "memoryAgent", threadId, step: "read-followup" }
        });

        const finalResponse = typeof followUpResponse.content === "string"
          ? cleanMarkdownForWhatsApp(followUpResponse.content)
          : "Aqui está o que tenho na memória.";

        return {
          messages: [new AIMessage(finalResponse)],
          nextAgent: "supervisor",
          contextData: { newExecution: "memoryAgent" }
        };
      }
    }

    // Step 3: No tool call → WRITE operation via structured output
    const structuredModel = model.withStructuredOutput(z.object({
      newMemoryContent: z.string().describe("O conteúdo atualizado completo da memória em markdown"),
      responseToUser: z.string().describe("Mensagem de confirmação para o usuário")
    }), { name: "MemoryAgentDecision" });

    const parsed = await structuredModel.invoke(messagesForModel, {
      metadata: { agentName: "memoryAgent", threadId, step: "write" }
    });

    // Save the new memory only if it actually changed
    if (parsed.newMemoryContent.trim() !== currentMemory.trim()) {
      updateMemory(chatJid, isTrustedChat, parsed.newMemoryContent);
      logger.info("[MEMORY_AGENT] Memória alterada. Gravando no disco.");
    } else {
      logger.info("[MEMORY_AGENT] Memória inalterada. Pulando gravação.");
    }

    // Format the response for WhatsApp
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
