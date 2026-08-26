import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { initWorkspaceTools, safeAgentNode, registerAgentResetCallback } from "./base.js";
import { modelFlash as model } from "../../llm/model.js";
import { AgentState } from "../state.js";

import { getSkill } from "../../skills/registry.js";

const GMAIL_PROMPT = getSkill("gmailAgent")?.detailedPrompt || "";

let gmailAgent: any = null;

registerAgentResetCallback(() => {
  gmailAgent = null;
});

async function initGmailAgent() {
  const tools = await initWorkspaceTools();
  if (!gmailAgent) {
    const messageModifier = tools.length > 0 
      ? GMAIL_PROMPT 
      : GMAIL_PROMPT + "\n\nAviso: As ferramentas do MCP falharam ao carregar.";
    
    gmailAgent = createReactAgent({
      llm: model,
      tools,
      messageModifier,
    });
  }
}

export async function gmailAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("gmailAgent", () => gmailAgent, state, initGmailAgent, config);
}
