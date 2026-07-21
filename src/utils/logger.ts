import fs from 'fs';
import path from 'path';
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { Serialized } from "@langchain/core/load/serializable";
import { LLMResult } from "@langchain/core/outputs";
import { BaseMessage } from "@langchain/core/messages";

const LOG_FILE = path.resolve(process.cwd(), 'data/bia_detailed.jsonl');

// Ensure data directory exists
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function writeDetailedLog(event: string, threadId: string | undefined, agentName: string | undefined, data: any) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event,
    threadId,
    agentName,
    data
  };
  
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n', 'utf-8');
  } catch (err) {
    console.error("Failed to write to detailed log file:", err);
  }
}

export class DetailedLoggingCallbackHandler extends BaseCallbackHandler {
  name = "detailed_logging_callback_handler";

  handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, any>,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = metadata?.threadId;
    const agentName = metadata?.agentName;
    writeDetailedLog("LLM_START", threadId, agentName, { prompts });
  }

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, any>,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = metadata?.threadId;
    const agentName = metadata?.agentName;
    
    let structuredMessages: any[] = [];
    if (messages && messages[0]) {
      structuredMessages = messages[0].map(msg => {
        let role = "Unknown";
        if (msg._getType() === "system" || msg.constructor.name === "SystemMessage") role = "SYSTEM";
        else if (msg._getType() === "human" || msg.constructor.name === "HumanMessage") role = "HUMAN";
        else if (msg._getType() === "ai" || msg.constructor.name === "AIMessage") role = "AI";
        else if (msg._getType() === "tool" || msg.constructor.name === "ToolMessage") role = "TOOL";
        
        return { role, content: msg.content };
      });
    }
    
    writeDetailedLog("LLM_START", threadId, agentName, { messages: structuredMessages });
  }

  handleLLMEnd(
    output: LLMResult,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = metadata?.threadId;
    const agentName = metadata?.agentName;
    
    const generations = output.generations || [];
    const structuredGenerations = generations.map(genList => 
      genList.map(gen => {
        const chatGen = gen as any;
        if (chatGen.message) {
          const toolCalls = chatGen.message.tool_calls;
          if (toolCalls && toolCalls.length > 0) {
            return { type: "tool_calls", toolCalls };
          }
          return { type: "message", content: chatGen.message.content };
        }
        return { type: "text", content: gen.text };
      })
    );
    
    writeDetailedLog("LLM_END", threadId, agentName, { generations: structuredGenerations });
  }

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = metadata?.threadId;
    const agentName = metadata?.agentName;
    const toolName = tool.name || (tool.id && tool.id[tool.id.length - 1]) || "unknown_tool";
    
    console.log(`[🕒 ${new Date().toLocaleTimeString()}] [${agentName || 'SYSTEM'}] Calling tool: "${toolName}" with input: ${input}`);
    
    writeDetailedLog("TOOL_START", threadId, agentName, { toolName, input });
  }

  handleToolEnd(
    output: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = metadata?.threadId;
    const agentName = metadata?.agentName;
    
    console.log(`[🕒 ${new Date().toLocaleTimeString()}] [${agentName || 'SYSTEM'}] Tool execution finished.`);
    
    writeDetailedLog("TOOL_END", threadId, agentName, { output });
  }
}

export const loggerCallbackHandler = new DetailedLoggingCallbackHandler();

export const logger = {
  info: (message: string, ...args: any[]) => {
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [INFO] ${message}`;
    console.log(cleanMsg, ...args);
    writeDetailedLog("INFO", undefined, undefined, { message, args: args.length ? args : undefined });
  },
  warn: (message: string, ...args: any[]) => {
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [WARN] ${message}`;
    console.warn(cleanMsg, ...args);
    writeDetailedLog("WARN", undefined, undefined, { message, args: args.length ? args : undefined });
  },
  error: (message: string, ...args: any[]) => {
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [ERROR] ${message}`;
    console.error(cleanMsg, ...args);
    writeDetailedLog("ERROR", undefined, undefined, { message, args: args.length ? args : undefined });
  },
  debug: (message: string, ...args: any[]) => {
    if (process.env.DEBUG) {
      const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [DEBUG] ${message}`;
      console.debug(cleanMsg, ...args);
    }
    writeDetailedLog("DEBUG", undefined, undefined, { message, args: args.length ? args : undefined });
  },
  logAgentStart: (agentName: string, threadId: string, contextData: any) => {
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [${agentName.toUpperCase()}] Starting execution...`;
    console.log(cleanMsg);
    
    writeDetailedLog("AGENT_START", threadId, agentName, { contextData });
  },
  logAgentDecision: (agentName: string, threadId: string, nextAgent: string, reason: string, response: string, intermediateMessage: string) => {
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [${agentName.toUpperCase()}] Decided to route to: "${nextAgent}" (Reason: ${reason})`;
    console.log(cleanMsg);
    
    writeDetailedLog("AGENT_DECISION", threadId, agentName, { nextAgent, reason, response, intermediateMessage });
  }
};
