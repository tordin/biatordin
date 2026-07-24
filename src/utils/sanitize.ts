import { BaseMessage, AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

export function sanitizeMessagesForModel(messages: BaseMessage[]): BaseMessage[] {
  const sanitized: BaseMessage[] = [];
  let lastContent = "";
  for (const msg of messages) {
    if (msg instanceof SystemMessage) {
      sanitized.push(new SystemMessage(msg.content));
      continue;
    }
    
    // Convert raw tool messages to SystemMessages to give the supervisor context of what the tools did
    if (msg instanceof ToolMessage) {
      sanitized.push(new SystemMessage(`[RESULTADO DA FERRAMENTA]: ${msg.content}`));
      continue;
    }

    if (msg instanceof AIMessage) {
      // Skip silent marker messages
      if (typeof msg.content === "string" && msg.content.trim().toUpperCase() === "[SILENT]") {
        continue;
      }

      // Skip intermediate tool execution messages
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        continue;
      }
      
      // Skip raw DeepSeek tool calls outputted as text strings to prevent formatting loops
      if (typeof msg.content === "string" && msg.content.includes("<｜｜DSML｜｜tool_calls>")) {
        continue;
      }

      // Deduplicate consecutive identical AI messages
      const currentContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (currentContent === lastContent) {
        continue;
      }
      lastContent = currentContent;

      sanitized.push(new AIMessage({ content: msg.content }));
      continue;
    }

    if (msg instanceof HumanMessage) {
      sanitized.push(new HumanMessage({ content: msg.content, name: msg.name }));
      lastContent = ""; // Reset deduplication on human message
      continue;
    }

    // Fallback copy
    sanitized.push(new HumanMessage({ content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }));
    lastContent = "";
  }
  return sanitized;
}

export function cleanJsonString(str: string): string {
  // Replace smart quotes if any
  let cleaned = str.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  
  // Extract content between markdown JSON fences if present
  const match = cleaned.match(/```json\s*([\s\S]*?)\s*```/);
  if (match && match[1]) {
    cleaned = match[1];
  } else {
    // Attempt to extract between first { and last }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
  }
  
  // Clean up any weird escaped newlines or extra spaces
  cleaned = cleaned.replace(/\\n/g, ' ').replace(/\s+/g, ' ');
  return cleaned;
}

/**
 * Builds a recency-anchored history window for agent prompts.
 * Inserts a SystemMessage demarcation between older context and the LAST message,
 * so the LLM clearly knows which message is the current request and which messages
 * are just historical context (preventing re-execution of old commands).
 * 
 * @param sanitizedHistory - Already sanitized message array
 * @param windowSize - Number of recent messages to include (default 12)
 * @returns Array of messages with a recency anchor marker
 */
export function buildRecencyAnchoredHistory(
  sanitizedHistory: BaseMessage[],
  windowSize: number = 12
): BaseMessage[] {
  const sliced = sanitizedHistory.slice(-windowSize);
  
  if (sliced.length <= 1) {
    // Only one message or empty — no need for a demarcation
    return sliced;
  }

  // Split into context (older) and current (last message)
  const contextMessages = sliced.slice(0, -1);
  const currentMessage = sliced[sliced.length - 1];

  const anchorMarker = new SystemMessage(
    "─── ATENÇÃO: FOCO NA MENSAGEM ATUAL ───\n" +
    "As mensagens ACIMA são CONTEXTO HISTÓRICO da conversa. Use-as APENAS para dar sentido à mensagem abaixo.\n" +
    "NÃO re-execute comandos, buscas ou ações de mensagens anteriores. Concentre-se EXCLUSIVAMENTE na mensagem a seguir.\n" +
    "Se a mensagem a seguir for uma saudação simples ('oi', 'boa noite', 'bom dia'), responda naturalmente SEM referenciar tarefas antigas.\n" +
    "─── MENSAGEM ATUAL DO USUÁRIO ───"
  );

  return [...contextMessages, anchorMarker, currentMessage];
}
