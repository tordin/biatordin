import { BaseMessage, AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

/**
 * Sanitiza o campo `name` de mensagens para conformidade com a API da Anthropic.
 * A API exige o padrão: ^[^\s<|\\/>]+$  (sem espaços, <, |, \, /, >).
 * Espaços são substituídos por "_" e os demais caracteres proibidos são removidos.
 * Se o resultado ficar vazio, retorna undefined para omitir o campo.
 */
export function sanitizeMessageName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  // OpenAI e Anthropic exigem formato estrito (sem espaços, sem caracteres especiais): ^[a-zA-Z0-9_-]{1,64}$
  const sanitized = name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^a-zA-Z0-9_-]/g, '_')                  // substitui caracteres não-alfanuméricos por _
    .replace(/^_+|_+$/g, '')                          // apara underscores no início/fim
    .substring(0, 64);
  return sanitized || undefined;
}

function extractLastDateFromContent(content: string): number | null {
  if (typeof content !== 'string') return null;
  const matches = [...content.matchAll(/\[(\d{2})\/(\d{2})\/(\d{4})[, ]+(\d{2}):(\d{2}):(\d{2})\]/g)];
  if (matches.length === 0) return null;
  const lastMatch = matches[matches.length - 1];
  const [_, day, month, year, hour, minute, second] = lastMatch;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
}

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
      if (typeof msg.content === "string" && msg.content.includes("<tool_calls>")) {
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
      const msgContentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const msgTime = extractLastDateFromContent(msgContentStr);
      const lastMsg = sanitized.length > 0 ? sanitized[sanitized.length - 1] : null;

      let grouped = false;
      if (lastMsg instanceof HumanMessage && lastMsg.name === msg.name) {
        const lastMsgContentStr = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
        const lastMsgTime = extractLastDateFromContent(lastMsgContentStr);

        // Agrupa se a diferença de tempo for menor que 10 minutos (600000 ms)
        if (msgTime && lastMsgTime && Math.abs(msgTime - lastMsgTime) < 600000) {
          lastMsg.content = `${lastMsgContentStr}\n${msgContentStr}`;
          grouped = true;
        }
      }

      if (!grouped) {
        sanitized.push(new HumanMessage({ content: msg.content, name: sanitizeMessageName(msg.name) }));
      }
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

  // Find the contiguous block of user messages at the end (message burst)
  let userBurstStartIndex = sliced.length - 1;
  const lastMsg = sliced[userBurstStartIndex];
  
  if (lastMsg instanceof HumanMessage) {
    while (userBurstStartIndex > 0) {
      const prevMsg = sliced[userBurstStartIndex - 1];
      if (prevMsg instanceof HumanMessage) {
        userBurstStartIndex--;
      } else {
        break;
      }
    }
  }

  // Split into context (older) and current (last burst or single message)
  const contextMessages = sliced.slice(0, userBurstStartIndex);
  const currentMessages = sliced.slice(userBurstStartIndex);

  if (contextMessages.length === 0) {
    return currentMessages;
  }

  const anchorMarker = new SystemMessage(
    "─── ATENÇÃO: FOCO NA MENSAGEM ATUAL ───\n" +
    "As mensagens ACIMA são CONTEXTO HISTÓRICO da conversa. Use-as APENAS para dar sentido à(s) mensagem(ões) abaixo.\n" +
    "NÃO re-execute comandos, buscas ou ações de mensagens anteriores. Concentre-se EXCLUSIVAMENTE nas mensagens a seguir.\n" +
    "Se as mensagens a seguir forem saudações simples ('oi', 'boa noite', 'bom dia'), responda naturalmente SEM referenciar tarefas antigas.\n" +
    "─── MENSAGEM(ÕES) ATUAL(IS) DO USUÁRIO ───"
  );

  return [...contextMessages, anchorMarker, ...currentMessages];
}
