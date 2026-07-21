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
