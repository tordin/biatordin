import { StateGraph } from "@langchain/langgraph";
import { AgentState } from "../agents/state.js";
import { supervisorNode } from "../agents/supervisor.js";
import { summarizerNode, shouldSummarize } from "../agents/summarizer.js";
import { searchAgentNode } from "../agents/search.js";
import { calendarAgentNode } from "../agents/workspace/calendar.js";
import { gmailAgentNode } from "../agents/workspace/gmail.js";
import { sheetsAgentNode } from "../agents/workspace/sheets.js";
import { docsAgentNode } from "../agents/workspace/docs.js";
import { driveAgentNode } from "../agents/workspace/drive.js";
import { routineAgentNode } from "../agents/routineAgent.js";
import { memoryAgentNode } from "../agents/memoryAgent.js";
import { taskAgentNode } from "../agents/taskAgent.js";
import { securityAgentNode } from "../agents/securityAgent.js";
import { shoppingAgentNode } from "../agents/shopping.js";
import { whatsappAgentNode } from "../agents/whatsappAgent.js";
import { reasoningAgentNode } from "../agents/reasoningAgent.js";
import { weatherAgentNode } from "../agents/weatherAgent.js";
import { missionAgentNode } from "../agents/missionAgent.js";
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
  if (next === "driveAgent") return "driveAgent";
  if (next === "routineAgent") return "routineAgent";
  if (next === "memoryAgent") return "memoryAgent";
  if (next === "taskAgent") return "taskAgent";
  if (next === "securityAgent") return "securityAgent";
  if (next === "shoppingAgent") return "shoppingAgent";
  if (next === "whatsappAgent") return "whatsappAgent";
  if (next === "reasoningAgent") return "reasoningAgent";
  if (next === "weatherAgent") return "weatherAgent";
  if (next === "missionAgent") return "missionAgent";
  return "__end__";
}

// Routes from specialist agents: allow FINISH → __end__ or back to supervisor
export function routeFromSpecialist(state: typeof AgentState.State) {
  const next = state.nextAgent;
  logger.info(`[ROUTING] Specialist routes to: "${next}"`);
  if (next === "FINISH") return "__end__";
  if (next === "supervisor") return "supervisor";
  return "supervisor";
}


const workflow = new StateGraph(AgentState)
  .addNode("summarizer", summarizerNode)
  .addNode("supervisor", supervisorNode)
  .addNode("searchAgent", searchAgentNode)
  .addNode("calendarAgent", calendarAgentNode)
  .addNode("gmailAgent", gmailAgentNode)
  .addNode("sheetsAgent", sheetsAgentNode)
  .addNode("docsAgent", docsAgentNode)
  .addNode("driveAgent", driveAgentNode)
  .addNode("routineAgent", routineAgentNode)
  .addNode("memoryAgent", memoryAgentNode)
  .addNode("taskAgent", taskAgentNode)
  .addNode("securityAgent", securityAgentNode)
  .addNode("shoppingAgent", shoppingAgentNode)
  .addNode("whatsappAgent", whatsappAgentNode)
  .addNode("reasoningAgent", reasoningAgentNode)
  .addNode("weatherAgent", weatherAgentNode)
  .addNode("missionAgent", missionAgentNode)
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
    driveAgent: "driveAgent",
    routineAgent: "routineAgent",
    memoryAgent: "memoryAgent",
    taskAgent: "taskAgent",
    securityAgent: "securityAgent",
    shoppingAgent: "shoppingAgent",
    whatsappAgent: "whatsappAgent",
    reasoningAgent: "reasoningAgent",
    weatherAgent: "weatherAgent",
    missionAgent: "missionAgent",
    __end__: "__end__",
  })
  .addConditionalEdges("searchAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("calendarAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("gmailAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("sheetsAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("docsAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("driveAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("routineAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("memoryAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("taskAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("securityAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("shoppingAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("whatsappAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("reasoningAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("weatherAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" })
  .addConditionalEdges("missionAgent", routeFromSpecialist, { supervisor: "supervisor", __end__: "__end__" });

export const agent = workflow.compile({ checkpointer });
