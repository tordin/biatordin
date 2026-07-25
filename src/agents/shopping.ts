import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";

const googleShoppingTool = tool(
  async ({ query }) => {
    const apiKey = process.env.SERPAPI_API_KEY;
    if (!apiKey) {
      logger.error("[GOOGLE SHOPPING] SERPAPI_API_KEY não definida nas variáveis de ambiente.");
      return JSON.stringify({ error: "SERPAPI_API_KEY não configurada." });
    }
    try {
      logger.info(`[GOOGLE SHOPPING] Buscando por: "${query}"`);
      const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&gl=br&hl=pt&api_key=${apiKey}`;
      const response = await fetch(url);

      if (response.ok) {
        const data = await response.json();
        const results = (data.shopping_results || []).slice(0, 10).map((item: any) => ({
          title: item.title,
          price: item.price,
          link: item.link,
          source: item.source,
        }));
        
        if (results.length === 0) {
          return JSON.stringify({ results: [], message: "Nenhum produto encontrado." });
        }
        return JSON.stringify({ results });
      } else {
        logger.error(`Erro na resposta da API do SerpAPI: ${response.status} ${response.statusText}`);
        return JSON.stringify({ error: `Erro na busca: ${response.statusText}` });
      }
    } catch (err) {
      logger.error("Erro ao chamar API do SerpAPI:", err);
      return JSON.stringify({ error: `Erro de conexão: ${(err as Error).message}` });
    }
  },
  {
    name: "google_shopping",
    description: "Pesquisa produtos, preços e lojas usando o Google Shopping. Use para encontrar itens para comprar, comparar preços e ver disponibilidade.",
    schema: z.object({
      query: z.string().describe("O nome do produto a ser pesquisado (ex: 'iPhone 15 Pro Max', 'Tênis Nike')."),
    }),
  }
);

import { getSkill } from "../skills/registry.js";

const SHOPPING_PROMPT = getSkill("shoppingAgent")?.detailedPrompt || "";

const shoppingAgent = createReactAgent({
  llm: model,
  tools: [googleShoppingTool],
  messageModifier: SHOPPING_PROMPT,
});

export async function shoppingAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("shoppingAgent", () => shoppingAgent, state, undefined, config);
}
