import { StateGraph } from "@langchain/langgraph";
import { AgentState } from "../agents/state.js";
import { supervisorNode } from "../agents/supervisor.js";
import { summarizerNode, shouldSummarize } from "../agents/summarizer.js";
import { searchAgentNode } from "../agents/search.js";
import { calendarAgentNode } from "../agents/workspace/calendar.js";
import { gmailAgentNode } from "../agents/workspace/gmail.js";
import { emailSentinelAgentNode } from "../agents/emailSentinelAgent.js";
import { sheetsAgentNode } from "../agents/workspace/sheets.js";
import { docsAgentNode } from "../agents/workspace/docs.js";
import { driveAgentNode } from "../agents/workspace/drive.js";
import { routineAgentNode } from "../agents/routineAgent.js";
import { memoryAgentNode } from "../agents/memoryAgent.js";
import { taskAgentNode } from "../agents/taskAgent.js";
import { trackerAgentNode } from "../agents/trackerAgent.js";
import { securityAgentNode } from "../agents/securityAgent.js";
import { shoppingAgentNode } from "../agents/shopping.js";
import { whatsappAgentNode } from "../agents/whatsappAgent.js";
import { reasoningAgentNode } from "../agents/reasoningAgent.js";
import { weatherAgentNode } from "../agents/weatherAgent.js";
import { missionAgentNode } from "../agents/missionAgent.js";
import { followUpAgentNode } from "../agents/followUpAgent.js";
import { crmAgentNode } from "../agents/crmAgent.js";
import { architectNode } from "../agents/architect.js";
import { outputGatewayNode } from "../agents/outputGateway.js";
import { checkpointer } from "../memory/checkpointer.js";
import { logger } from "../utils/logger.js";

// Routes from supervisor to specialist agents, evaluator or directly to outputGateway
export function routeFromSupervisor(state: typeof AgentState.State) {
  const next = state.nextAgent;
  let target = "outputGateway";

  if (next === "searchAgent") target = "searchAgent";
  else if (next === "calendarAgent") target = "calendarAgent";
  else if (next === "gmailAgent") target = "gmailAgent";
  else if (next === "emailSentinelAgent") target = "emailSentinelAgent";
  else if (next === "sheetsAgent") target = "sheetsAgent";
  else if (next === "docsAgent") target = "docsAgent";
  else if (next === "driveAgent") target = "driveAgent";
  else if (next === "routineAgent") target = "routineAgent";
  else if (next === "memoryAgent") target = "memoryAgent";
  else if (next === "taskAgent") target = "taskAgent";
  else if (next === "trackerAgent") target = "trackerAgent";
  else if (next === "securityAgent") target = "securityAgent";
  else if (next === "shoppingAgent") target = "shoppingAgent";
  else if (next === "whatsappAgent") target = "whatsappAgent";
  else if (next === "reasoningAgent") target = "reasoningAgent";
  else if (next === "weatherAgent") target = "weatherAgent";
  else if (next === "missionAgent") target = "missionAgent";
  else if (next === "followUpAgent") target = "followUpAgent";
  else if (next === "crmAgent") target = "crmAgent";
  else if (state.contextData?.accountName === "personal") {
    logger.info(`[ROUTING] Conta pessoal (passiva) detectada. Pulando avaliador direto para outputGateway.`);
    target = "outputGateway";
  } else if (state.contextData?.proposedResponse && state.contextData.proposedResponse.trim().toUpperCase() === "[SILENT]") {
    logger.info(`[ROUTING] Resposta silenciosa [SILENT] detectada. Pulando avaliador direto para outputGateway.`);
    target = "outputGateway";
  } else if ((state.contextData?.executedTools || []).length === 0 && (state.contextData?.executionLog || []).length === 0) {
    logger.info(`[ROUTING] Execução trivial detectada (nenhuma ferramenta/agente chamado). Pulando avaliador direto para outputGateway.`);
    target = "outputGateway";
  } else {
    target = "outputGateway";
  }

  logger.info(`[ROUTING] Supervisor decision "${next}" -> routed to: "${target}"`);
  return target;
}

// Routes from specialist agents: allow FINISH → outputGateway or back to supervisor
export function routeFromSpecialist(state: typeof AgentState.State) {
  const next = state.nextAgent;
  logger.info(`[ROUTING] Specialist routes to: "${next}"`);
  if (next === "FINISH") return "outputGateway";
  if (next === "supervisor") return "supervisor";
  return "supervisor";
}


const workflow = new StateGraph(AgentState)
  .addNode("summarizer", summarizerNode)
  .addNode("supervisor", supervisorNode)
  .addNode("searchAgent", searchAgentNode)
  .addNode("calendarAgent", calendarAgentNode)
  .addNode("gmailAgent", gmailAgentNode)
  .addNode("emailSentinelAgent", emailSentinelAgentNode)
  .addNode("sheetsAgent", sheetsAgentNode)
  .addNode("docsAgent", docsAgentNode)
  .addNode("driveAgent", driveAgentNode)
  .addNode("routineAgent", routineAgentNode)
  .addNode("memoryAgent", memoryAgentNode)
  .addNode("taskAgent", taskAgentNode)
  .addNode("trackerAgent", trackerAgentNode)
  .addNode("securityAgent", securityAgentNode)
  .addNode("shoppingAgent", shoppingAgentNode)
  .addNode("whatsappAgent", whatsappAgentNode)
  .addNode("reasoningAgent", reasoningAgentNode)
  .addNode("weatherAgent", weatherAgentNode)
  .addNode("missionAgent", missionAgentNode)
  .addNode("followUpAgent", followUpAgentNode)
  .addNode("crmAgent", crmAgentNode)
  .addNode("architect", architectNode)
  .addNode("outputGateway", outputGatewayNode)
  .addConditionalEdges("__start__", shouldSummarize, {
    summarizer: "summarizer",
    supervisor: "supervisor",
    architect: "architect",
  })
  .addConditionalEdges("summarizer", (state) => state.contextData.routeTarget === "architect" ? "architect" : "supervisor", { supervisor: "supervisor", architect: "architect" })
  .addConditionalEdges("supervisor", routeFromSupervisor, {
    searchAgent: "searchAgent",
    calendarAgent: "calendarAgent",
    gmailAgent: "gmailAgent",
    emailSentinelAgent: "emailSentinelAgent",
    sheetsAgent: "sheetsAgent",
    docsAgent: "docsAgent",
    driveAgent: "driveAgent",
    routineAgent: "routineAgent",
    memoryAgent: "memoryAgent",
    taskAgent: "taskAgent",
    trackerAgent: "trackerAgent",
    securityAgent: "securityAgent",
    shoppingAgent: "shoppingAgent",
    whatsappAgent: "whatsappAgent",
    reasoningAgent: "reasoningAgent",
    weatherAgent: "weatherAgent",
    missionAgent: "missionAgent",
    followUpAgent: "followUpAgent",
    crmAgent: "crmAgent",
    architect: "architect",
    outputGateway: "outputGateway",
  })
  .addConditionalEdges("searchAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("calendarAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("gmailAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("emailSentinelAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("sheetsAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("docsAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("driveAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("routineAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("memoryAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("taskAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("trackerAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("securityAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("shoppingAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("whatsappAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("reasoningAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("weatherAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("missionAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("followUpAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  .addConditionalEdges("crmAgent", routeFromSpecialist, { supervisor: "supervisor", outputGateway: "outputGateway" })
  
  .addEdge("architect", "supervisor")
  .addEdge("outputGateway", "__end__");

export const agent = workflow.compile({ checkpointer });
