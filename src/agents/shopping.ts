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
    const apiKey = process.env.SERPAPI_API_KEY || "a8523c463b6d667e0cc91aebff2988039bb5cf7397fd13fa063a42d7155fa95a";
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

const SHOPPING_PROMPT = 
  "Você é o Agente de Compras (Especialista em Produtos e Preços) da Bia.\n" +
  "Sua função principal é buscar produtos, comparar preços e encontrar lojas usando a ferramenta `google_shopping`.\n" +
  "Sempre use as ferramentas para fundamentar suas respostas.\n" +
  "Diretrizes importantes:\n" +
  "1. REGRAS DE CUSTO (MUITO IMPORTANTE): FAÇA APENAS UMA (1) BUSCA por execução. A API tem um limite estrito de custo/cota, portanto NUNCA realize buscas repetidas com pequenas variações do termo (ex: 'iPhone 17 256 GB' e 'iPhone 17 256GB'). Pense bem no termo, faça a melhor busca na primeira tentativa e contente-se com os resultados obtidos.\n" +
  "2. PRIORIDADE DE LOJAS: Ignore completamente resultados de marketplaces internacionais sujeitos a impostos de importação e de qualidade duvidosa (como AliExpress, eBay, Techinn, etc). Filtre os resultados retornados pela busca e traga apenas opções de vendedores nacionais de credibilidade (como Amazon, Mercado Livre, Magazine Luiza, Carrefour, Kabum, Fast Shop, etc).\n" +
  "3. Liste os produtos encontrados informando título, preço, loja (source) e o link para compra.\n" +
  "4. Seja objetivo e estruture os dados recuperados de forma clara para que a supervisora (Bia) formule a resposta final. Não responda diretamente ao usuário final.";

const shoppingAgent = createReactAgent({
  llm: model,
  tools: [googleShoppingTool],
  messageModifier: SHOPPING_PROMPT,
});

export async function shoppingAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("shoppingAgent", () => shoppingAgent, state, undefined, config);
}
