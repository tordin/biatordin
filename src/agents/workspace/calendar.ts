import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { initWorkspaceTools, safeAgentNode } from "./base.js";
import { modelPro as model } from "../../llm/model.js";
import { AgentState } from "../state.js";

const CALENDAR_PROMPT = 
  "Você é o Agente de Calendário da Bia.\n" +
  "Sua função principal é gerenciar o Google Calendar do usuário usando as ferramentas MCP fornecidas.\n" +
  "Tenha muito cuidado ao criar ou modificar eventos. Sempre use as ferramentas fornecidas.\n" +
  "Liste os eventos recuperados ou criados com precisão para que a supervisora (Bia) formule a resposta final. Não responda diretamente ao usuário final.";

let calendarAgent: any = null;

async function initCalendarAgent() {
  if (!calendarAgent) {
    const tools = await initWorkspaceTools();
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
