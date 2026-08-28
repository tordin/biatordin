import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { initWorkspaceTools, safeAgentNode, registerAgentResetCallback } from "./base.js";
import { modelFlash as model } from "../../llm/model.js";
import { AgentState } from "../state.js";

import { getSkill } from "../../skills/registry.js";
import { SystemMessage } from "@langchain/core/messages";

const CALENDAR_PROMPT = getSkill("calendarAgent")?.detailedPrompt || "";

let calendarAgent: any = null;

registerAgentResetCallback(() => {
  calendarAgent = null;
});

async function initCalendarAgent() {
  const tools = await initWorkspaceTools();
  if (!calendarAgent) {
    const messageModifier = tools.length > 0 
      ? CALENDAR_PROMPT 
      : CALENDAR_PROMPT + "\n\nAviso: As ferramentas do MCP falharam ao carregar.";
    
    calendarAgent = createReactAgent({
      llm: model,
      tools,
      messageModifier,
    });
  }
}

export async function calendarAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("calendarAgent", () => calendarAgent, state, initCalendarAgent, config);
}
