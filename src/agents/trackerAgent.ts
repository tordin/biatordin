import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { createTracker, getTracker, updateTracker, listTrackers, deleteTracker } from "../memory/trackers.js";
import { getSkill } from "../skills/registry.js";

export const createTrackerTool = tool(
  async ({ name, purpose, data }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat (thread_id ausente).";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");
    const topicId = config?.configurable?.contextData?.activeTopicId;

    try {
      // Validate JSON
      JSON.parse(data);
      const tracker = await createTracker(chatJid, name, purpose, data, topicId);
      return `✅ Tracker criado com sucesso! ID: ${tracker.id} | Nome: "${tracker.name}"`;
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        return `Erro ao criar tracker: O campo 'data' deve ser um JSON válido.`;
      }
      logger.error("Erro ao criar tracker:", err);
      return `Erro ao salvar tracker no banco de dados: ${err.message}`;
    }
  },
  {
    name: "create_tracker",
    description: "Cria um novo Tracker (Plano/Inventário genérico baseado em JSON). Útil para organizar listas estruturadas, como 'Plano de Manutenção', 'Despensa' ou estoques complexos.",
    schema: z.object({
      name: z.string().describe("Nome do Tracker (ex: 'Plano de Manutenção da Casa')."),
      purpose: z.string().describe("Propósito do Tracker e regras para a Bia (ex: 'Gerencia as datas de manutenção dos itens. Campos: nome, frequencia_meses, ultima_data, proxima_data')."),
      data: z.string().describe("Objeto JSON válido (em string) contendo os dados iniciais estruturados do tracker.")
    })
  }
);

export const listTrackersTool = tool(
  async ({}, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat.";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");
    const isTrustedChat = config?.configurable?.contextData?.isTrustedChat ?? true;

    try {
      const trackers = await listTrackers(chatJid, isTrustedChat);
      if (trackers.length === 0) {
        return "Nenhum Tracker encontrado.";
      }

      const formattedList = trackers.map(t => 
        `ID: ${t.id} | Nome: ${t.name} | Propósito: ${t.purpose}`
      ).join("\n");

      return `<RAW_TOOL_OUTPUT source="sqlite:trackers">\nLista de Trackers Ativos:\n${formattedList}\n</RAW_TOOL_OUTPUT>`;
    } catch (err: any) {
      logger.error("Erro ao listar trackers:", err);
      return `Erro ao consultar trackers no banco de dados: ${err.message}`;
    }
  },
  {
    name: "list_trackers",
    description: "Lista os Trackers ativos do usuário, exibindo ID, nome e propósito.",
    schema: z.object({})
  }
);

export const getTrackerTool = tool(
  async ({ id }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat.";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");
    const isTrustedChat = config?.configurable?.contextData?.isTrustedChat ?? true;

    try {
      const tracker = await getTracker(id, chatJid, isTrustedChat);
      if (tracker) {
        return `<RAW_TOOL_OUTPUT source="sqlite:trackers">\nTracker ID: ${tracker.id}\nNome: ${tracker.name}\nPropósito: ${tracker.purpose}\nDados JSON:\n${tracker.data}\n</RAW_TOOL_OUTPUT>`;
      } else {
        return `Tracker ID ${id} não encontrado.`;
      }
    } catch (err: any) {
      logger.error("Erro ao obter tracker:", err);
      return `Erro ao consultar tracker: ${err.message}`;
    }
  },
  {
    name: "get_tracker",
    description: "Obtém os detalhes completos de um Tracker pelo ID, incluindo seu conteúdo JSON estruturado.",
    schema: z.object({
      id: z.number().describe("O ID numérico do Tracker.")
    })
  }
);

export const updateTrackerTool = tool(
  async ({ id, data }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat.";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");
    const isTrustedChat = config?.configurable?.contextData?.isTrustedChat ?? true;

    try {
      // Validate JSON
      JSON.parse(data);
      const success = await updateTracker(id, chatJid, data, isTrustedChat);
      if (success) {
        return `✅ Tracker ID ${id} atualizado com sucesso!`;
      } else {
        return `Tracker ID ${id} não encontrado ou sem permissão para atualizar.`;
      }
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        return `Erro ao atualizar tracker: O campo 'data' deve ser um JSON válido.`;
      }
      logger.error("Erro ao atualizar tracker:", err);
      return `Erro ao atualizar tracker: ${err.message}`;
    }
  },
  {
    name: "update_tracker",
    description: "Atualiza completamente o conteúdo JSON de um Tracker pelo ID. Você deve passar o JSON COMPLETO modificado, e não apenas o delta.",
    schema: z.object({
      id: z.number().describe("O ID numérico do Tracker."),
      data: z.string().describe("Objeto JSON válido (em string) contendo TODO o estado atualizado do tracker.")
    })
  }
);

export const deleteTrackerTool = tool(
  async ({ id }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat.";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");
    const isTrustedChat = config?.configurable?.contextData?.isTrustedChat ?? true;

    try {
      const success = await deleteTracker(id, chatJid, isTrustedChat);
      if (success) {
        return `🗑️ Tracker ID ${id} foi excluído com sucesso.`;
      } else {
        return `Tracker ID ${id} não foi encontrado.`;
      }
    } catch (err: any) {
      logger.error("Erro ao excluir tracker:", err);
      return `Erro ao excluir tracker: ${err.message}`;
    }
  },
  {
    name: "delete_tracker",
    description: "Exclui definitivamente um Tracker pelo seu ID numérico.",
    schema: z.object({
      id: z.number().describe("O ID numérico do Tracker.")
    })
  }
);

const TRACKER_PROMPT = getSkill("trackerAgent")?.detailedPrompt || 
  "Você é o Agente de Gestão de Trackers Genéricos (Tracker Manager) da Bia.\n" +
  "Você é responsável por gerenciar listas e estruturas JSON que não se encaixam em tarefas simples, como Planos de Manutenção, Controle de Despensa, etc.\n" +
  "Sempre que você criar ou atualizar um tracker, projete um JSON limpo e bem estruturado. Quando precisar alterar um valor, recupere o tracker com get_tracker, modifique o JSON internamente, e chame update_tracker passando a string do JSON completo com a sua alteração.\n" +
  "Seja objetivo e informe os resultados com clareza.";

const trackerAgent = createReactAgent({
  llm: model,
  tools: [createTrackerTool, listTrackersTool, getTrackerTool, updateTrackerTool, deleteTrackerTool],
  messageModifier: TRACKER_PROMPT,
});

export async function trackerAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("trackerAgent", () => trackerAgent, state, undefined, config);
}
