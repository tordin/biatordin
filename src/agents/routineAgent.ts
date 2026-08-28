import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { saveRoutine, getRoutinesForChat, updateRoutine, deactivateRoutine, deleteRoutine } from "../memory/routines.js";
import { scheduleRoutine, descheduleRoutine } from "../utils/routineManager.js";

export const createRoutineTool = tool(
  async ({ cronExpression, prompt }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat (thread_id ausente).";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");
    const topicId = config?.configurable?.contextData?.activeTopicId;

    try {
        const routine = await saveRoutine(chatJid, cronExpression, prompt, topicId);
        scheduleRoutine(routine);
        return `Rotina criada com sucesso! ID: ${routine.id}. Cron: ${cronExpression}. Prompt: "${prompt}"`;
    } catch (err: any) {
        logger.error("Erro ao criar rotina:", err);
        return `Erro ao criar rotina no banco de dados: ${err.message}`;
    }
  },
  {
    name: "create_routine",
    description: "Cria uma nova rotina agendada ou lembrete para o usuário atual. Use expressões CRON válidas do node-cron. Ex: '0 9 * * *' para todos os dias às 9h.",
    schema: z.object({
      cronExpression: z.string().describe("A expressão cron para o agendamento (ex: '0 9 * * *' para 9 da manhã todos os dias, ou '*/5 * * * *' para cada 5 min)."),
      prompt: z.string().describe("A instrução ou mensagem que o sistema deve mandar quando a rotina for disparada. Ex: 'Por favor, me mande as principais notícias do dia.' ou 'Me lembre de beber água.'"),
    }),
  }
);

export const updateRoutineTool = tool(
  async ({ id, cronExpression, prompt }, config) => {
    try {
      const updates: { cronExpression?: string; prompt?: string } = {};
      if (cronExpression) updates.cronExpression = cronExpression;
      if (prompt) updates.prompt = prompt;

      const updated = await updateRoutine(id, updates);
      if (!updated) {
        return `Erro: rotina ID ${id} não encontrada no banco de dados.`;
      }
      if (updated.isActive) {
        scheduleRoutine(updated);
      }
      return `Rotina ID ${id} atualizada com sucesso! Novo Cron: ${updated.cronExpression}. Novo Prompt: "${updated.prompt}"`;
    } catch (err: any) {
      logger.error("Erro ao atualizar rotina:", err);
      return `Erro ao atualizar rotina ID ${id}: ${err.message}`;
    }
  },
  {
    name: "update_routine",
    description: "Modifica / atualiza o prompt ou a expressão cron de uma rotina agendada existente pelo seu ID.",
    schema: z.object({
      id: z.number().describe("O ID numérico da rotina a ser modificada."),
      cronExpression: z.string().optional().describe("Nova expressão cron (opcional se apenas o prompt for alterado)."),
      prompt: z.string().optional().describe("Novo prompt / instrução da rotina (opcional se apenas o cron for alterado)."),
    }),
  }
);

export const listRoutinesTool = tool(
  async ({}, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat.";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");

    try {
        const routines = await getRoutinesForChat(chatJid);
        if (routines.length === 0) return "Nenhuma rotina ativa encontrada para este usuário.";
        
        const list = routines.slice(0, 30).map(r => `- [ID: ${r.id}] Cron: ${r.cronExpression} | ${r.prompt}`).join("\n");
        const extra = routines.length > 30 ? `\n...e mais ${routines.length - 30} rotinas ocultas.` : "";
        return `<RAW_TOOL_OUTPUT source="sqlite:routines">\nRotinas ativas:\n${list}${extra}\n</RAW_TOOL_OUTPUT>`;
    } catch (err: any) {
        logger.error("Erro ao listar rotinas:", err);
        return `Erro ao listar rotinas: ${err.message}`;
    }
  },
  {
    name: "list_routines",
    description: "Lista todas as rotinas e lembretes ativos do usuário atual.",
    schema: z.object({}),
  }
);

export const deleteRoutineTool = tool(
  async ({ id }, config) => {
    try {
        await deactivateRoutine(id);
        descheduleRoutine(id);
        return `Rotina ID ${id} foi cancelada com sucesso.`;
    } catch (err: any) {
        logger.error("Erro ao cancelar rotina:", err);
        return `Erro ao cancelar rotina: ${err.message}`;
    }
  },
  {
    name: "delete_routine",
    description: "Cancela (exclui) uma rotina ou lembrete pelo seu ID. Use a ferramenta list_routines para descobrir o ID se não souber.",
    schema: z.object({
      id: z.number().describe("O ID numérico da rotina a ser cancelada."),
    }),
  }
);

import { getSkill } from "../skills/registry.js";

const ROUTINE_PROMPT = getSkill("routineAgent")?.detailedPrompt || "";

export const routineAgent = createReactAgent({
  llm: model,
  tools: [createRoutineTool, updateRoutineTool, listRoutinesTool, deleteRoutineTool],
  messageModifier: ROUTINE_PROMPT,
});

export async function routineAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("routineAgent", () => routineAgent, state, undefined, config);
}

