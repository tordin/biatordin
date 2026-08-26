import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { Serialized } from "@langchain/core/load/serializable";
import { LLMResult } from "@langchain/core/outputs";
import { BaseMessage } from "@langchain/core/messages";
import { biaEvents } from "./events.js";

const LOG_FILE = path.resolve(process.cwd(), 'data/bia_detailed.jsonl');

// Ensure data directory exists
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

/* ============================================================
   TRIGGER TRACKING
   Maps threadId → active trigger context for the current
   processing cycle. This allows every log entry written
   during an agent invocation to carry the same triggerEventId,
   making it trivial to group all events by their root cause.
   ============================================================ */

export type TriggerType = 'whatsapp_message' | 'cron_routine' | 'system_inject' | 'startup' | 'connection';

export interface TriggerMetadata {
  isGroup?: boolean;
  mentionsBia?: boolean;
  isReplyToBot?: boolean;
  wasReceivedWhileProcessing?: boolean;
}

export interface TriggerContext {
  triggerId: string;
  triggerType: TriggerType;
  threadId: string;
  chatJid?: string;
  chatName?: string;
  senderJid?: string;
  senderName?: string;
  accountName?: string;
  /** Raw message text exactly as the user sent it */
  messageContent?: string;
  /** Structured metadata about the trigger event */
  metadata?: TriggerMetadata;
  /** For cron: the routine ID */
  routineId?: number;
  /** For cron: the routine prompt */
  routinePrompt?: string;
  startedAt: string;
}

/** Map of threadId → active TriggerContext */
const activeTriggers = new Map<string, TriggerContext>();

/**
 * Generates a short trigger ID (8 hex chars) for readability.
 */
export function generateTriggerId(): string {
  return randomUUID().replace(/-/g, '').substring(0, 8).toUpperCase();
}

/**
 * Sets the active trigger for a given thread. Call this before invoking
 * the agent graph so that all subsequent log entries carry the same triggerId.
 */
export function setActiveTrigger(threadId: string, ctx: Omit<TriggerContext, 'startedAt'>): TriggerContext {
  const trigger: TriggerContext = {
    ...ctx,
    startedAt: new Date().toISOString(),
  };
  activeTriggers.set(threadId, trigger);
  return trigger;
}

/**
 * Returns the active trigger context for a threadId, or undefined.
 */
export function getActiveTrigger(threadId: string): TriggerContext | undefined {
  return activeTriggers.get(threadId);
}

/**
 * Clears the active trigger for a thread once processing is complete.
 */
export function clearActiveTrigger(threadId: string): void {
  activeTriggers.delete(threadId);
}

/* ============================================================
   CORE WRITE FUNCTION
   ============================================================ */

export interface LogEntry {
  timestamp: string;
  event: string;
  threadId?: string;
  agentName?: string;
  /** ID of the root triggering event that caused this log entry */
  triggerId?: string;
  /** Type of the event that started this processing cycle */
  triggerType?: TriggerType;
  data: any;
}

import { AsyncLocalStorage } from 'async_hooks';

export const triggerStorage = new AsyncLocalStorage<TriggerContext>();

/**
 * Runs an async function within a specific TriggerContext store.
 * All logger calls inside fn (and its async children) will automatically
 * inherit threadId, triggerId, and triggerType.
 */
export function runWithTriggerContext<T>(ctx: TriggerContext, fn: () => Promise<T> | T): Promise<T> | T {
  activeTriggers.set(ctx.threadId, ctx);
  return triggerStorage.run(ctx, fn);
}

function writeDetailedLog(
  event: string,
  threadId: string | undefined,
  agentName: string | undefined,
  data: any,
  overrideTrigger?: { triggerId: string; triggerType: TriggerType }
) {
  const timestamp = new Date().toISOString();

  // Auto-resolve trigger from AsyncLocalStorage context or active trigger map if not overridden
  let triggerId: string | undefined;
  let triggerType: TriggerType | undefined;

  const asyncCtx = triggerStorage.getStore();

  if (overrideTrigger) {
    triggerId = overrideTrigger.triggerId;
    triggerType = overrideTrigger.triggerType;
  } else if (asyncCtx) {
    triggerId = asyncCtx.triggerId;
    triggerType = asyncCtx.triggerType;
    if (!threadId) threadId = asyncCtx.threadId;
  } else if (threadId) {
    const active = activeTriggers.get(threadId);
    if (active) {
      triggerId = active.triggerId;
      triggerType = active.triggerType;
    }
  }

  const logEntry: LogEntry = {
    timestamp,
    event,
    threadId,
    agentName,
    triggerId,
    triggerType,
    data
  };

  try {
    if (process.env.NODE_ENV !== 'test' && process.env.JEST_WORKER_ID === undefined) {
      fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n', 'utf-8');
    }
    biaEvents.emit('log', logEntry);
  } catch (err) {
    console.error("Failed to write to detailed log file:", err);
  }
}

/* ============================================================
   LANGCHAIN CALLBACK HANDLER
   ============================================================ */

const runToThreadMap = new Map<string, string>();

/* ============================================================
   LLM_START / LLM_END DEDUPLICATION BY RUN ID
   O handler de callbacks é anexado em dois níveis (model e graph),
   então handleChatModelStart + handleLLMStart (e handleLLMEnd)
   disparam DUAS vezes para a mesma chamada, com o MESMO runId.
   Para não poluir o JSONL e o debugger com nós duplicados:
   - LLM_START: bufferiza por runId e emite UM evento mesclado
     (messages do chat-model + prompts do LLM).
   - LLM_END: emite apenas o primeiro evento por runId.
   ============================================================ */
interface PendingLlmStart {
  threadId?: string;
  agentName?: string;
  data: Record<string, any>;
  timer?: NodeJS.Timeout;
}
const pendingLlmStarts = new Map<string, PendingLlmStart>();
const writtenLlmEndRunIds = new Set<string>();
const writtenToolStartRunIds = new Set<string>();
const writtenToolEndRunIds = new Set<string>();
const MAX_TRACKED_RUN_IDS = 2000;

function queueLlmStart(
  runId: string,
  threadId: string | undefined,
  agentName: string | undefined,
  data: Record<string, any>
) {
  if (!runId) {
    // Sem runId (legado): escreve imediatamente
    writeDetailedLog("LLM_START", threadId, agentName, data);
    return;
  }

  let entry = pendingLlmStarts.get(runId);
  if (!entry) {
    entry = { threadId, agentName, data: {} };
    pendingLlmStarts.set(runId, entry);
    const newEntry = entry;
    newEntry.timer = setTimeout(() => {
      pendingLlmStarts.delete(runId);
      writeDetailedLog("LLM_START", newEntry.threadId, newEntry.agentName, { ...newEntry.data, runId });
    }, 30);

    // Evita crescimento sem limite caso o callback gêmeo nunca chegue
    if (pendingLlmStarts.size > MAX_TRACKED_RUN_IDS) {
      const firstKey = pendingLlmStarts.keys().next().value;
      const oldest = typeof firstKey === 'string' ? pendingLlmStarts.get(firstKey) : undefined;
      if (oldest && typeof firstKey === 'string') {
        if (oldest.timer) clearTimeout(oldest.timer);
        pendingLlmStarts.delete(firstKey);
        writeDetailedLog("LLM_START", oldest.threadId, oldest.agentName, { ...oldest.data, runId: firstKey });
      }
    }
  }

  // Mescla dados dos dois callbacks (messages do chat-model, prompts do LLM)
  if (data.messages) entry.data.messages = data.messages;
  if (data.prompts) entry.data.prompts = data.prompts;
}

function isDuplicateLlmEnd(runId: string): boolean {
  if (!runId) return false;
  if (writtenLlmEndRunIds.has(runId)) return true;
  writtenLlmEndRunIds.add(runId);
  if (writtenLlmEndRunIds.size > MAX_TRACKED_RUN_IDS) {
    const oldestRunId = writtenLlmEndRunIds.values().next().value;
    if (oldestRunId) writtenLlmEndRunIds.delete(oldestRunId);
  }
  return false;
}

function isDuplicateToolStart(runId: string): boolean {
  if (!runId) return false;
  if (writtenToolStartRunIds.has(runId)) return true;
  writtenToolStartRunIds.add(runId);
  if (writtenToolStartRunIds.size > MAX_TRACKED_RUN_IDS) {
    const oldestRunId = writtenToolStartRunIds.values().next().value;
    if (oldestRunId) writtenToolStartRunIds.delete(oldestRunId);
  }
  return false;
}

function isDuplicateToolEnd(runId: string): boolean {
  if (!runId) return false;
  if (writtenToolEndRunIds.has(runId)) return true;
  writtenToolEndRunIds.add(runId);
  if (writtenToolEndRunIds.size > MAX_TRACKED_RUN_IDS) {
    const oldestRunId = writtenToolEndRunIds.values().next().value;
    if (oldestRunId) writtenToolEndRunIds.delete(oldestRunId);
  }
  return false;
}

function resolveThreadId(runId: string, parentRunId?: string, tags?: string[], metadata?: any): string | undefined {
    let threadId = metadata?.threadId || metadata?.configurable?.thread_id;
    
    if (!threadId && tags) {
        const threadTag = tags.find(t => t.startsWith("thread_id:"));
        if (threadTag) threadId = threadTag.split(":")[1];
    }
    
    if (threadId) {
        runToThreadMap.set(runId, threadId);
        return threadId;
    }
    
    if (parentRunId && runToThreadMap.has(parentRunId)) {
        threadId = runToThreadMap.get(parentRunId);
        if (threadId) runToThreadMap.set(runId, threadId);
        return threadId;
    }
    
    return undefined;
}

export class DetailedLoggingCallbackHandler extends BaseCallbackHandler {
  name = "detailed_logging_callback_handler";

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, any>,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = resolveThreadId(runId, parentRunId, tags, metadata);
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

    // Usa queueLlmStart para mesclar com handleLLMStart (mesmo runId)
    // e evitar eventos duplicados no JSONL/debugger.
    queueLlmStart(runId, threadId, agentName, { messages: structuredMessages });
  }

  handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, any>,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = resolveThreadId(runId, parentRunId, tags, metadata);
    const agentName = metadata?.agentName;
    queueLlmStart(runId, threadId, agentName, { prompts });
  }

  handleLLMEnd(
    output: LLMResult,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = resolveThreadId(runId, parentRunId, tags, metadata);
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

    if (isDuplicateLlmEnd(runId)) return;
    writeDetailedLog("LLM_END", threadId, agentName, { generations: structuredGenerations, runId });
  }

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>,
    runName?: string,
    toolCallId?: string
  ) {
    const threadId = resolveThreadId(runId, parentRunId, tags, metadata);
    const agentName = metadata?.agentName;
    // O nome real da tool vem no runName (config.runName = tool.name). O objeto
    // serializado (toJSON) de DynamicStructuredTool só expõe a classe genérica
    // ("DynamicStructuredTool") e perde o nome real — por isso o fallback antigo
    // poluía o debugger com "DynamicStructuredTool" para todas as ferramentas.
    const toolName = runName
      || (tool as any)?.kwargs?.name
      || tool.name
      || (tool.id && tool.id[tool.id.length - 1])
      || "unknown_tool";

    console.log(`[🕒 ${new Date().toLocaleTimeString()}] [${agentName || 'SYSTEM'}] Calling tool: "${toolName}" with input: ${input}`);

    if (isDuplicateToolStart(runId)) return;
    writeDetailedLog("TOOL_START", threadId, agentName, { toolName, input, runId });
  }

  handleToolEnd(
    output: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = resolveThreadId(runId, parentRunId, tags, metadata);
    const agentName = metadata?.agentName;

    console.log(`[🕒 ${new Date().toLocaleTimeString()}] [${agentName || 'SYSTEM'}] Tool execution finished.`);

    if (isDuplicateToolEnd(runId)) return;
    writeDetailedLog("TOOL_END", threadId, agentName, { output, runId });
  }

  handleToolError(
    err: any,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>
  ) {
    const threadId = resolveThreadId(runId, parentRunId, tags, metadata);
    const agentName = metadata?.agentName;
    const errorStr = typeof err === "string" ? err : (err?.message || JSON.stringify(err));

    console.error(`[🕒 ${new Date().toLocaleTimeString()}] [${agentName || 'SYSTEM'}] Tool execution failed:`, errorStr);

    if (isDuplicateToolEnd(runId)) return;
    writeDetailedLog("TOOL_END", threadId, agentName, { output: `Error: ${errorStr}`, isError: true, runId });
  }
}

export const loggerCallbackHandler = new DetailedLoggingCallbackHandler();

/* ============================================================
   PUBLIC LOGGER API
   ============================================================ */

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

  logAgentStart: (agentName: string, threadId: string, contextData: any, messages?: any[]) => {
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [${agentName.toUpperCase()}] Starting execution...`;
    console.log(cleanMsg);
    
    let structuredMessages;
    if (messages) {
      structuredMessages = messages.map(msg => {
        let role = "Unknown";
        if (msg._getType) {
          const type = msg._getType();
          if (type === "system") role = "SYSTEM";
          else if (type === "human") role = "HUMAN";
          else if (type === "ai") role = "AI";
          else if (type === "tool") role = "TOOL";
        } else if (msg.constructor) {
          if (msg.constructor.name === "SystemMessage") role = "SYSTEM";
          else if (msg.constructor.name === "HumanMessage") role = "HUMAN";
          else if (msg.constructor.name === "AIMessage") role = "AI";
          else if (msg.constructor.name === "ToolMessage") role = "TOOL";
        }
        return { role, content: msg.content, name: msg.name, tool_calls: msg.tool_calls };
      });
    }

    writeDetailedLog("AGENT_START", threadId, agentName, { contextData, messages: structuredMessages });
  },

  logAgentDecision: (
    agentName: string,
    threadId: string,
    decision: any
  ) => {
    const nextAgent = decision?.nextAgent || "unknown";
    const reason = decision?.reason || "no reason provided";
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [${agentName.toUpperCase()}] Decided to route to: "${nextAgent}" (Reason: ${reason})`;
    console.log(cleanMsg);
    writeDetailedLog("AGENT_DECISION", threadId, agentName, decision);
  },

  /**
   * Logs the root triggering event. Call this *before* invoking the agent graph.
   * This is the anchor event that all other events in this processing cycle
   * will reference via triggerId.
   */
  logTriggerEvent: (trigger: TriggerContext) => {
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [TRIGGER:${trigger.triggerType}] ID=${trigger.triggerId} Thread=${trigger.threadId} From=${trigger.senderName || trigger.chatJid || 'SYSTEM'}`;
    console.log(cleanMsg);

    writeDetailedLog(
      "TRIGGER",
      trigger.threadId,
      undefined,
      {
        triggerId: trigger.triggerId,
        triggerType: trigger.triggerType,
        chatJid: trigger.chatJid,
        chatName: trigger.chatName,
        senderJid: trigger.senderJid,
        senderName: trigger.senderName,
        accountName: trigger.accountName,
        messageContent: trigger.messageContent,
        metadata: trigger.metadata,
        routineId: trigger.routineId,
        routinePrompt: trigger.routinePrompt,
      },
      { triggerId: trigger.triggerId, triggerType: trigger.triggerType }
    );
  },

  /**
   * Logs the outcome of a trigger (what Bia did).
   * Call this *after* the agent graph returns.
   */
  logTriggerOutcome: (
    trigger: TriggerContext,
    outcome: {
      action: 'silent' | 'responded' | 'error';
      responseText?: string;
      reason?: string;
      agentsUsed?: string[];
      durationMs?: number;
      error?: string;
    }
  ) => {
    const actionEmoji = outcome.action === 'silent' ? '🔇' : outcome.action === 'responded' ? '✅' : '❌';
    const reasonMsg = outcome.reason ? ` (motivo: ${outcome.reason})` : '';
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [TRIGGER_END] ID=${trigger.triggerId} ${actionEmoji} ${outcome.action.toUpperCase()}${reasonMsg} ${outcome.agentsUsed?.length ? `(agents: ${outcome.agentsUsed.join(' → ')})` : ''}`;
    console.log(cleanMsg);

    writeDetailedLog(
      "TRIGGER_END",
      trigger.threadId,
      undefined,
      {
        triggerId: trigger.triggerId,
        triggerType: trigger.triggerType,
        chatJid: trigger.chatJid,
        chatName: trigger.chatName,
        senderName: trigger.senderName,
        accountName: trigger.accountName,
        action: outcome.action,
        responseText: outcome.responseText,
        reason: outcome.reason,
        agentsUsed: outcome.agentsUsed,
        durationMs: outcome.durationMs,
        error: outcome.error,
      },
      { triggerId: trigger.triggerId, triggerType: trigger.triggerType }
    );
  },

  /**
   * Logs an outbound message sent by Bia.
   * Uses the active AsyncLocalStorage trigger context to tie the message to a root cause.
   */
  logOutboundMessage: (chatJid: string, text: string) => {
    const trigger = triggerStorage.getStore() || (chatJid ? getActiveTrigger(chatJid) : undefined);
    const cleanMsg = `[🕒 ${new Date().toLocaleTimeString()}] [OUTBOUND_MESSAGE] To=${chatJid} Text="${text.substring(0, 50).replace(/\n/g, ' ')}${text.length > 50 ? '...' : ''}"`;
    console.log(cleanMsg);

    writeDetailedLog(
      "OUTBOUND_MESSAGE",
      trigger?.threadId,
      undefined,
      {
        chatJid,
        text
      },
      trigger ? { triggerId: trigger.triggerId, triggerType: trigger.triggerType } : undefined
    );
  },
};
