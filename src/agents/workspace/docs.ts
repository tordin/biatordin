import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { initWorkspaceTools, safeAgentNode, registerAgentResetCallback } from "./base.js";
import { modelFlash as model } from "../../llm/model.js";
import { AgentState } from "../state.js";

import { getSkill } from "../../skills/registry.js";

const DOCS_PROMPT = getSkill("docsAgent")?.detailedPrompt || "";

let docsAgent: any = null;

registerAgentResetCallback(() => {
  docsAgent = null;
});

async function initDocsAgent() {
  const tools = await initWorkspaceTools();
  if (!docsAgent) {
    const messageModifier = tools.length > 0 
      ? DOCS_PROMPT 
      : DOCS_PROMPT + "\n\nAviso: As ferramentas do MCP falharam ao carregar.";
    
    docsAgent = createReactAgent({
      llm: model,
      tools,
      messageModifier,
    });
  }
}

export async function docsAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("docsAgent", () => docsAgent, state, initDocsAgent, config);
}
