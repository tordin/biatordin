import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { AIMessage, SystemMessage, RemoveMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { sanitizeMessagesForModel, buildRecencyAnchoredHistory } from "../../utils/sanitize.js";
import { generateDynamicErrorResponse } from "../../utils/dynamicErrorResponse.js";
import { AgentState } from "../state.js";
import { logger } from "../../utils/logger.js";
import dotenv from "dotenv";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

class LoopDetectionCallbackHandler extends BaseCallbackHandler {
  name = "LoopDetectionCallbackHandler";
  private toolCalls: string[] = [];

  async handleToolStart(tool: any, input: any) {
    const toolName = tool?.id?.[tool?.id?.length - 1] || tool?.name || "unknown";
    const inputStr = typeof input === "string" ? input : JSON.stringify(input);
    const callSignature = `${toolName}:${inputStr}`;
    this.toolCalls.push(callSignature);
    
    const len = this.toolCalls.length;
    if (len >= 3) {
      if (
        this.toolCalls[len - 1] === this.toolCalls[len - 2] && 
        this.toolCalls[len - 2] === this.toolCalls[len - 3]
      ) {
        throw new Error(`Loop detectado: A ferramenta ${toolName} foi chamada 3 vezes seguidas com os exatos mesmos argumentos.`);
      }
    }
  }
}

let workspaceTools: any[] = [];
let isInitialized = false;
let lastKnownRefreshToken = "";
const agentResetCallbacks: (() => void)[] = [];

export function registerAgentResetCallback(cb: () => void) {
  agentResetCallbacks.push(cb);
}

export function resetWorkspaceTools() {
  workspaceTools = [];
  isInitialized = false;
  lastKnownRefreshToken = "";
  for (const cb of agentResetCallbacks) {
    try { cb(); } catch {}
  }
}

export async function initWorkspaceTools(force = false) {
  // Reload dotenv to pick up any changes the user made to the .env file while the process was running
  dotenv.config({ override: true });

  const currentRefreshToken = process.env.GOOGLE_REFRESH_TOKEN || "";
  const tokenChanged = isInitialized && currentRefreshToken !== lastKnownRefreshToken;

  if (!force && !tokenChanged && isInitialized && workspaceTools.length > 0) {
    return workspaceTools;
  }

  if (tokenChanged || force) {
    for (const cb of agentResetCallbacks) {
      try { cb(); } catch {}
    }
  }

  if (tokenChanged) {
    logger.info("[WORKSPACE AGENTS] GOOGLE_REFRESH_TOKEN alterado no .env. Reinicializando MCP Client...");
  } else {
    logger.info("[WORKSPACE AGENTS] Initializing MCP Client...");
  }

  const mcpClient = new MultiServerMCPClient({
    google_workspace: {
      command: "npx",
      args: ["-y", "mcp-server-google-workspace"],
      env: {
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
        GOOGLE_REFRESH_TOKEN: currentRefreshToken,
        GOOGLE_USER_EMAIL: process.env.GOOGLE_USER_EMAIL || "primary",
        PATH: process.env.PATH || ""
      }
    }
  });

  try {
    const toolsMap = await mcpClient.initializeConnections();
    workspaceTools = toolsMap["google_workspace"] || [];
    if (workspaceTools.length > 0) {
      isInitialized = true;
      lastKnownRefreshToken = currentRefreshToken;
      logger.info(`[WORKSPACE AGENTS] Loaded ${workspaceTools.length} tools from MCP.`);
    } else {
      logger.warn("[WORKSPACE AGENTS] MCP initialized but returned 0 tools.");
    }
  } catch (err) {
    logger.error("[WORKSPACE AGENTS] Error initializing MCP:", err);
    workspaceTools = [];
    isInitialized = false;
  }

  return workspaceTools;
}

export async function safeAgentNode(
  name: string,
  getAgent: () => any,
  state: typeof AgentState.State,
  initFn?: () => Promise<void>,
  config?: RunnableConfig,
  systemContext?: string
) {
  const threadId = config?.configurable?.thread_id || "";
  try {
    if (initFn) await initFn();
    
    const agentInstance = getAgent();
    if (!agentInstance) {
      throw new Error(`Agente ${name} não está inicializado.`);
    }
    
    const specialistTask = state.contextData?.specialistTask || (state as any).specialistTask;

    const dateTimeMessage = new SystemMessage(
      `[DATA E HORA ATUAL]: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`
    );
    const messagesWithTime: any[] = [dateTimeMessage];
    
    if (systemContext) {
      messagesWithTime.push(new SystemMessage(systemContext));
    }
    
    if (specialistTask) {
      messagesWithTime.push(new SystemMessage(`[INSTRUÇÃO DA SUPERVISORA (TAREFA DESSA EXECUÇÃO)]:\n${specialistTask}`));
      // Para o missionAgent, incluir também o histórico recente de mensagens.
      // Sem isto, ele não vê a mensagem real do Target e precisa "adivinhar" pelo specialistTask.
      if (name === 'missionAgent') {
        const cleanHistory = state.messages.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
        const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);
        const slicedHistory = buildRecencyAnchoredHistory(sanitizedHistory, 6);
        messagesWithTime.push(...slicedHistory);
      }
    } else {
      const cleanHistory = state.messages.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
      const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);
      const slicedHistory = buildRecencyAnchoredHistory(sanitizedHistory, 12);
      messagesWithTime.push(...slicedHistory);
    }

    logger.logAgentStart(name, threadId, state.contextData, messagesWithTime);
    
    // Timeout de 120 segundos (2 minutos) para evitar travamento da execução
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout: ${name} demorou mais de 120s`)), 120000)
    );
    
    const loopDetector = new LoopDetectionCallbackHandler();
    const mergedCallbacks = config?.callbacks 
      ? (Array.isArray(config.callbacks) ? [...config.callbacks, loopDetector] : [config.callbacks as any, loopDetector])
      : [loopDetector];

    const response = await Promise.race([
      agentInstance.invoke(
        { messages: messagesWithTime },
        { 
          ...config, 
          recursionLimit: 15,
          callbacks: mergedCallbacks,
          configurable: { 
            ...config?.configurable, 
            contextData: state.contextData, 
            agentName: name, 
            threadId 
          } 
        }
      ),
      timeoutPromise
    ]) as any;
    
    const newMessages = response.messages.slice(messagesWithTime.length);
    
    // Extract executed tools from the new messages
    const executedTools: string[] = [];
    for (const msg of newMessages) {
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
                if (tc.name) executedTools.push(tc.name);
            }
        } else if (msg.name && msg.getType && msg.getType() === 'tool') {
            executedTools.push(msg.name);
        }
    }
    
    if (newMessages.length > 0) {
      const respostaBruta = newMessages[newMessages.length - 1].content;
      // Routing instruction diferenciada para o missionAgent:
      // O missionAgent já enviou mensagens diretamente via suas tools, então a Supervisora
      // NÃO deve gerar resposta final (evita resumos internos vazando para o chat do Target).
      const isMissionAgent = name === 'missionAgent';
      const routingInst = isMissionAgent
          ? `O missionAgent já enviou mensagens diretamente via suas tools (send_message_to_target, notify_master, etc). ` +
            `Defina nextAgent='FINISH' e response='[SILENT]'. ` +
            `NÃO formule nenhuma resposta final ao usuário — o missionAgent já cuidou de toda a comunicação.`
          : `Se ainda houver etapas pendentes no plano de execução ativo ou outras ações solicitadas pelo usuário, continue a execução roteando para o próximo especialista pendente preenchendo 'nextAgent' e 'specialistTask'. Somente quando TODAS as etapas do plano/ações solicitadas tiverem sido concluídas com sucesso (ou em caso de erro impeditivo), USE EXATAMENTE OS DADOS coletados para formular a resposta final amigável ao usuário no campo 'response' e defina nextAgent='FINISH'. NÃO repita buscas ou ações já concluídas.`;
      const mensagemAncorada = new AIMessage(
         `<specialist_return agent="${name}">\n` +
         `<collected_data>\n${respostaBruta}\n</collected_data>\n` +
         `<routing_instruction>\n` +
         `${routingInst}\n` +
         `</routing_instruction>\n` +
         `</specialist_return>`
      );
      newMessages[newMessages.length - 1] = mensagemAncorada;
    }
    
    return {
      messages: newMessages,
      nextAgent: "supervisor",
      contextData: { 
        newExecution: name,
        newExecutedTools: executedTools 
      }
    };
  } catch (error: any) {
    logger.error(`[${name.toUpperCase()} ERROR]`, error.message || error);
    
    const isTimeout = error.message?.includes("Timeout");
    const problemDescription = isTimeout
      ? `A consulta pelo agente especialista ${name} excedeu o limite de tempo.`
      : `Ocorreu uma oscilação temporária na execução do especialista ${name}: ${error.message || 'erro desconhecido'}`;

    const userNotice = await generateDynamicErrorResponse({
      messages: state.messages,
      problemDescription
    });

    const errorMessage = new AIMessage(
      `<specialist_return agent="${name}" status="error">\n` +
      `<error_details>Motivo: ${isTimeout ? 'Timeout' : (error.message || 'Erro desconhecido')}</error_details>\n` +
      `<routing_instruction>\nOcorreu uma falha no agente. NÃO repita a chamada para este agente no mesmo turno. Defina nextAgent='FINISH' e avise o usuário repassando amigavelmente o recado a seguir:\n${userNotice}\n</routing_instruction>\n` +
      `</specialist_return>`
    );
    
    return {
      messages: [errorMessage],
      nextAgent: "supervisor",
      contextData: { 
        newExecution: name,
        lastError: `${name}: ${error.message || 'erro desconhecido'}`
      }
    };
  }
}
