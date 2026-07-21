import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { initWorkspaceTools, safeAgentNode } from "./base.js";
import { modelPro as model } from "../../llm/model.js";
import { AgentState } from "../state.js";

const GMAIL_PROMPT = 
  "Você é o Agente de Gmail da Bia.\n" +
  "Sua função principal é gerenciar o Gmail do usuário usando as ferramentas MCP fornecidas.\n" +
  "Você pode ler, pesquisar e enviar e-mails.\n" +
  "Liste os e-mails recuperados ou as ações realizadas com precisão para que a supervisora (Bia) formule a resposta final. Não responda diretamente ao usuário final.";

let gmailAgent: any = null;

async function initGmailAgent() {
  if (!gmailAgent) {
    const tools = await initWorkspaceTools();
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
