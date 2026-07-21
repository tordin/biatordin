import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { AIMessage, SystemMessage, RemoveMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { sanitizeMessagesForModel } from "../../utils/sanitize.js";
import { AgentState } from "../state.js";
import { logger } from "../../utils/logger.js";
import dotenv from "dotenv";

let workspaceTools: any[] = [];
let isInitialized = false;

export async function initWorkspaceTools() {
  if (isInitialized && workspaceTools.length > 0) return workspaceTools;
  
  // Reload dotenv to pick up any changes the user made to the .env file while the process was running
  dotenv.config({ override: true });

  logger.info("[WORKSPACE AGENTS] Initializing MCP Client...");
  
  const mcpClient = new MultiServerMCPClient({
    google_workspace: {
      command: "npx",
      args: ["-y", "mcp-server-google-workspace"],
      env: {
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
        GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN || "",
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
  config?: RunnableConfig
) {
  const threadId = config?.configurable?.thread_id || "";
  logger.logAgentStart(name, threadId, state.contextData);
  
  try {
    if (initFn) await initFn();
    
    const agentInstance = getAgent();
    if (!agentInstance) {
      throw new Error(`Agente ${name} não está inicializado.`);
    }
    
    const cleanHistory = state.messages.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
    const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);
    const slicedHistory = sanitizedHistory.slice(-12);
    
    const dateTimeMessage = new SystemMessage(
      `[DATA E HORA ATUAL]: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`
    );
    const messagesWithTime = [dateTimeMessage, ...slicedHistory];
    
    // Timeout de 60 segundos para evitar travamento indefinido
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout: ${name} demorou mais de 60s`)), 60000)
    );
    
    const response = await Promise.race([
      agentInstance.invoke(
        { messages: messagesWithTime },
        { metadata: { agentName: name, threadId } }
      ),
      timeoutPromise
    ]) as any;
    
    const newMessages = response.messages.slice(messagesWithTime.length);
    
    return {
      messages: newMessages,
      nextAgent: "supervisor",
      contextData: { newExecution: name }
    };
  } catch (error: any) {
    logger.error(`[${name.toUpperCase()} ERROR]`, error.message || error);
    
    const errorMessage = new AIMessage(
      `[ERRO do agente ${name}]: ${error.message || 'Falha desconhecida ao executar a tarefa.'}`
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
