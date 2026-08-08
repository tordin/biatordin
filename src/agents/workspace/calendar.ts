import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { initWorkspaceTools, safeAgentNode } from "./base.js";
import { modelFlash as model } from "../../llm/model.js";
import { AgentState } from "../state.js";

import { getSkill } from "../../skills/registry.js";
import { SystemMessage } from "@langchain/core/messages";

const CALENDAR_PROMPT = getSkill("calendarAgent")?.detailedPrompt || "";

let calendarAgent: any = null;

async function initCalendarAgent() {
  if (!calendarAgent) {
    const tools = await initWorkspaceTools();
    
    const messageModifier = (state: any) => {
      let prompt = CALENDAR_PROMPT;
      const isTrusted = state.contextData?.isTrustedChat ?? true;
      if (!isTrusted) {
        prompt += "\n\nRESTRIÇÃO DE SEGURANÇA (MODO DE TERCEIROS):\nVocê está consultando a agenda em nome de um terceiro. NUNCA revele o nome, descrição, local ou participantes dos eventos existentes. Responda APENAS informando se o horário está 'ocupado' ou 'livre'. Você tem permissão para encontrar espaços na agenda e agendar novos compromissos se solicitado.";
      }
      if (tools.length === 0) {
        prompt += "\n\nAviso: As ferramentas do MCP falharam ao carregar.";
      }
      return new SystemMessage(prompt);
    };
    
    calendarAgent = createReactAgent({
      llm: model,
      tools,
      prompt: messageModifier as any,
    });
  }
}

export async function calendarAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("calendarAgent", () => calendarAgent, state, initCalendarAgent, config);
}
