import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";

async function serperSearch(query: string, timeframe?: string): Promise<string | null> {
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return null;

  const body: Record<string, any> = {
    q: query,
    num: 10,
    gl: "br",
    hl: "pt-br",
  };
  if (timeframe) {
    body.tbs = `qdr:${timeframe}`;
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`[GOOGLE SEARCH] Chamando API do Serper (tentativa ${attempt}/${maxRetries}) para: "${query}"`);
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": serperKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const data = await response.json();
        const results = (data.organic || []).map((item: any) => ({
          title: item.title,
          url: item.link,
          content: item.snippet,
        }));
        return JSON.stringify({ results });
      }

      logger.error(`Erro na resposta da API do Serper (tentativa ${attempt}/${maxRetries}): ${response.status} ${response.statusText}`);
    } catch (err) {
      logger.error(`Erro ao chamar API do Serper (tentativa ${attempt}/${maxRetries}):`, err);
    }

    if (attempt < maxRetries) {
      const delay = 1000 * attempt; // backoff: 1s, 2s, 3s
      logger.info(`[GOOGLE SEARCH] Aguardando ${delay}ms antes da próxima tentativa...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return null;
}

async function jinaSearchFallback(query: string): Promise<string | null> {
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    logger.info(`[JINA FALLBACK] Tentando Jina Reader como fallback para: "${query}"`);
    const response = await fetch(`https://r.jina.ai/${searchUrl}`, {
      method: "GET",
      headers: {
        "Accept": "text/plain",
      },
    });

    if (response.ok) {
      let content = await response.text();
      if (content.length > 10000) {
        content = content.substring(0, 10000) + "\n\n...[Conteúdo truncado]...";
      }
      // Normalize to same structured format as Serper for consistent LLM input
      return JSON.stringify({
        results: [{
          title: `Resultados da busca para: ${query}`,
          url: searchUrl,
          content: content.substring(0, 2000),
        }],
        source: "jina_fallback",
      });
    } else {
      logger.error(`Jina Reader fallback falhou: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    logger.error("Erro ao chamar Jina Reader como fallback:", err);
  }

  return null;
}

const googleSearchTool = tool(
  async ({ query, timeframe }) => {
    // 1. Try Serper with retry + backoff
    const serperResult = await serperSearch(query, timeframe);
    if (serperResult) {
      return serperResult;
    }

    // 2. Fallback: Jina Reader on Google search URL
    const jinaResult = await jinaSearchFallback(query);
    if (jinaResult) {
      return jinaResult;
    }

    // 3. All failed — return clear error
    logger.error(`[GOOGLE SEARCH] Todas as tentativas de busca falharam para: "${query}"`);
    return "Não consegui buscar informações agora. Tente novamente mais tarde.";
  },
  {
    name: "google_search",
    description: "Pesquisa informações atualizadas na internet (Busca Google). Use para buscar fatos em tempo real, clima, notícias e cotações financeiras.",
    schema: z.object({
      query: z.string().describe("O termo ou frase de busca a ser pesquisado no Google."),
      timeframe: z
        .enum(["h", "d", "w", "m", "y"])
        .optional()
        .describe(
          "Filtra os resultados pelo período: 'h' (última hora), 'd' (últimas 24 horas), 'w' (última semana), 'm' (último mês), 'y' (último ano). " +
          "Use 'h' ou 'd' para eventos extremamente recentes, resultados de jogos de hoje, notícias urgentes ou acontecimentos recentes."
        ),
    }),
  }
);

const openWebpageTool = tool(
  async ({ url }) => {
    logger.info(`[OPEN WEBPAGE] Lendo conteúdo da URL via Jina Reader: ${url}`);
    try {
      const response = await fetch(`https://r.jina.ai/${url}`, {
        method: "GET",
        headers: {
          "Accept": "text/plain",
        },
      });

      if (response.ok) {
        let content = await response.text();
        // Limit the content length so we don't blow up the LLM context window
        if (content.length > 20000) {
          content = content.substring(0, 20000) + "\n\n...[Conteúdo truncado por ser muito longo]...";
        }
        return content;
      } else {
        logger.error(`Erro ao ler URL ${url}: ${response.status} ${response.statusText}`);
        return `Erro ao tentar ler a página: ${response.statusText}`;
      }
    } catch (err) {
      logger.error(`Erro de conexão ao ler URL ${url}:`, err);
      return `Erro de conexão ao tentar ler a página: ${(err as Error).message}`;
    }
  },
  {
    name: "open_webpage",
    description: "Abre uma URL específica e retorna o texto completo (limpo) da página. Útil quando os snippets da busca não fornecem detalhes suficientes e você precisa ler o conteúdo real da página ou notícia.",
    schema: z.object({
      url: z.string().url().describe("A URL completa da página a ser lida."),
    }),
  }
);

const RESEARCHER_PROMPT = 
  "Você é o Agente de Busca (Especialista em Busca do Google) da Bia.\n" +
  "Sua função principal é reunir fatos do mundo real, atualizados e precisos na internet usando a ferramenta `google_search`.\n" +
  "Você também tem a capacidade de ler o conteúdo completo de sites usando a ferramenta `open_webpage`.\n" +
  "Sempre use as ferramentas para fundamentar suas respostas.\n" +
  "Diretrizes importantes:\n" +
  "1. Evite realizar buscas repetidas, redundantes ou muito similares. Se uma busca não trouxe o resultado esperado, mude a estratégia ou os termos de busca significativamente.\n" +
  "2. Use `google_search` para obter um panorama geral e os snippets. Se a informação estiver incompleta e você precisar se aprofundar, chame `open_webpage` na URL mais promissora entre os resultados.\n" +
  "3. Limite-se a no máximo 3 chamadas de ferramentas (buscas ou leituras de página) por execução. Se após 3 chamadas você não encontrar tudo, consolide o que encontrou, indique o que ficou faltando e encerre sua execução.\n" +
  "4. Certifique-se de usar o parâmetro 'timeframe' da busca de forma inteligente quando exigir informações muito recentes (use 'h' ou 'd' para eventos de hoje).\n" +
  "5. Seja objetivo e liste os dados recuperados com precisão para que a supervisora (Bia) formule a resposta final. Não responda diretamente ao usuário final.";

const searchAgent = createReactAgent({
  llm: model,
  tools: [googleSearchTool, openWebpageTool],
  messageModifier: RESEARCHER_PROMPT,
});

export async function searchAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("searchAgent", () => searchAgent, state, undefined, config);
}
