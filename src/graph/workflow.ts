import { StateGraph } from "@langchain/langgraph";
import { AgentState } from "../agents/state.js";
import { supervisorNode } from "../agents/supervisor.js";
import { summarizerNode, shouldSummarize } from "../agents/summarizer.js";
import { chitchatNode } from "../agents/chitchat.js";
import { searchAgentNode } from "../agents/search.js";
import { calendarAgentNode } from "../agents/workspace/calendar.js";
import { gmailAgentNode } from "../agents/workspace/gmail.js";
import { sheetsAgentNode } from "../agents/workspace/sheets.js";
import { docsAgentNode } from "../agents/workspace/docs.js";
import { routineAgentNode } from "../agents/routineAgent.js";
import { memoryAgentNode } from "../agents/memoryAgent.js";
import { taskAgentNode } from "../agents/taskAgent.js";
import { securityAgentNode } from "../agents/securityAgent.js";
import { shoppingAgentNode } from "../agents/shopping.js";
import { whatsappAgentNode } from "../agents/whatsappAgent.js";
import { reasoningAgentNode } from "../agents/reasoningAgent.js";
import { weatherAgentNode } from "../agents/weatherAgent.js";
import { checkpointer } from "../memory/checkpointer.js";
import { logger } from "../utils/logger.js";

// Routes from supervisor to specialist agents based on supervisor's decision
export function routeFromSupervisor(state: typeof AgentState.State) {
  const next = state.nextAgent;
  logger.info(`[ROUTING] Supervisor decision routes to: "${next}"`);
  if (next === "searchAgent") return "searchAgent";
  if (next === "chitchat") return "chitchat";
  if (next === "calendarAgent") return "calendarAgent";
  if (next === "gmailAgent") return "gmailAgent";
  if (next === "sheetsAgent") return "sheetsAgent";
  if (next === "docsAgent") return "docsAgent";
  if (next === "routineAgent") return "routineAgent";
  if (next === "memoryAgent") return "memoryAgent";
  if (next === "taskAgent") return "taskAgent";
  if (next === "securityAgent") return "securityAgent";
  if (next === "shoppingAgent") return "shoppingAgent";
  if (next === "whatsappAgent") return "whatsappAgent";
  if (next === "reasoningAgent") return "reasoningAgent";
  if (next === "weatherAgent") return "weatherAgent";
  return "__end__";
}

export function routeFromSpecialist(state: typeof AgentState.State) {
  if (state.nextAgent === "FINISH") {
    logger.info(`[ROUTING] Specialist signaled FINISH. Going to __end__ directly.`);
    return "__end__";
  }
  logger.info(`[ROUTING] Specialist signaled continuation. Returning to supervisor.`);
  return "supervisor";
}

const workflow = new StateGraph(AgentState)
  .addNode("summarizer", summarizerNode)
  .addNode("supervisor", supervisorNode)
  .addNode("searchAgent", searchAgentNode)
  .addNode("chitchat", chitchatNode)
  .addNode("calendarAgent", calendarAgentNode)
  .addNode("gmailAgent", gmailAgentNode)
  .addNode("sheetsAgent", sheetsAgentNode)
  .addNode("docsAgent", docsAgentNode)
  .addNode("routineAgent", routineAgentNode)
  .addNode("memoryAgent", memoryAgentNode)
  .addNode("taskAgent", taskAgentNode)
  .addNode("securityAgent", securityAgentNode)
  .addNode("shoppingAgent", shoppingAgentNode)
  .addNode("whatsappAgent", whatsappAgentNode)
  .addNode("reasoningAgent", reasoningAgentNode)
  .addNode("weatherAgent", weatherAgentNode)
  .addConditionalEdges("__start__", shouldSummarize, {
    summarizer: "summarizer",
    supervisor: "supervisor",
  })
  .addEdge("summarizer", "supervisor")
  .addConditionalEdges("supervisor", routeFromSupervisor, {
    searchAgent: "searchAgent",
    chitchat: "chitchat",
    calendarAgent: "calendarAgent",
    gmailAgent: "gmailAgent",
    sheetsAgent: "sheetsAgent",
    docsAgent: "docsAgent",
    routineAgent: "routineAgent",
    memoryAgent: "memoryAgent",
    taskAgent: "taskAgent",
    securityAgent: "securityAgent",
    shoppingAgent: "shoppingAgent",
    whatsappAgent: "whatsappAgent",
    reasoningAgent: "reasoningAgent",
    weatherAgent: "weatherAgent",
    __end__: "__end__",
  })
  .addConditionalEdges("searchAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("chitchat", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("calendarAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("gmailAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("sheetsAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("docsAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("routineAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("memoryAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("taskAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("securityAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("shoppingAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("whatsappAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("reasoningAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("weatherAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" });

export const agent = workflow.compile({ checkpointer });
