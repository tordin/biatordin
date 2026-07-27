import { StateGraph } from "@langchain/langgraph";
import { AgentState } from "../agents/state.js";
import { supervisorNode } from "../agents/supervisor.js";
import { summarizerNode, shouldSummarize } from "../agents/summarizer.js";
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


const workflow = new StateGraph(AgentState)
  .addNode("summarizer", summarizerNode)
  .addNode("supervisor", supervisorNode)
  .addNode("searchAgent", searchAgentNode)
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
  .addEdge("searchAgent", "supervisor")
  .addEdge("calendarAgent", "supervisor")
  .addEdge("gmailAgent", "supervisor")
  .addEdge("sheetsAgent", "supervisor")
  .addEdge("docsAgent", "supervisor")
  .addEdge("routineAgent", "supervisor")
  .addEdge("memoryAgent", "supervisor")
  .addEdge("taskAgent", "supervisor")
  .addEdge("securityAgent", "supervisor")
  .addEdge("shoppingAgent", "supervisor")
  .addEdge("whatsappAgent", "supervisor")
  .addEdge("reasoningAgent", "supervisor")
  .addEdge("weatherAgent", "supervisor");

export const agent = workflow.compile({ checkpointer });
