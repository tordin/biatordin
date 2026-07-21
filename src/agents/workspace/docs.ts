import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { initWorkspaceTools, safeAgentNode } from "./base.js";
import { modelPro as model } from "../../llm/model.js";
import { AgentState } from "../state.js";

const DOCS_PROMPT = 
  "Você é o Agente de Google Docs da Bia.\n" +
  "Sua função principal é gerenciar, ler e editar os Google Docs do usuário usando as ferramentas MCP fornecidas.\n" +
  "Você pode ler documentos, criá-los ou anexar texto.\n" +
  "Liste o texto recuperado ou as ações realizadas com precisão para que a supervisora (Bia) formule a resposta final. Não responda diretamente ao usuário final.";

let docsAgent: any = null;

async function initDocsAgent() {
  if (!docsAgent) {
    const tools = await initWorkspaceTools();
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
