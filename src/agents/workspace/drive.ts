import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { initWorkspaceTools, safeAgentNode, registerAgentResetCallback } from "./base.js";
import { modelFlash as model } from "../../llm/model.js";
import { AgentState } from "../state.js";
import { getSkill } from "../../skills/registry.js";

const DRIVE_PROMPT = getSkill("driveAgent")?.detailedPrompt || "";

let driveAgent: any = null;

registerAgentResetCallback(() => {
  driveAgent = null;
});

async function initDriveAgent() {
  const tools = await initWorkspaceTools();
  if (!driveAgent) {
    const messageModifier = tools.length > 0 
      ? DRIVE_PROMPT 
      : DRIVE_PROMPT + "\n\nAviso: As ferramentas do MCP falharam ao carregar.";
    
    driveAgent = createReactAgent({
      llm: model,
      tools,
      messageModifier,
    });
  }
}

export async function driveAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("driveAgent", () => driveAgent, state, initDriveAgent, config);
}
