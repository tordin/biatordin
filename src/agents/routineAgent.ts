import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelPro as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { saveRoutine, getRoutinesForChat, deactivateRoutine, deleteRoutine } from "../memory/routines.js";
import { scheduleRoutine, descheduleRoutine } from "../utils/routineManager.js";

const createRoutineTool = tool(
  async ({ cronExpression, prompt }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat (thread_id ausente).";
    const chatJid = threadId.includes('_') ? threadId.split('_')[0] : threadId;

    try {
        const routine = await saveRoutine(chatJid, cronExpression, prompt);
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

const listRoutinesTool = tool(
  async ({}, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat.";
    const chatJid = threadId.includes('_') ? threadId.split('_')[0] : threadId;

    try {
        const routines = await getRoutinesForChat(chatJid);
        if (routines.length === 0) return "Nenhuma rotina ativa encontrada para este usuário.";
        
        const list = routines.map(r => `ID: ${r.id} | Cron: ${r.cronExpression} | Prompt: ${r.prompt}`).join("\n");
        return `Rotinas ativas:\n${list}`;
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

const deleteRoutineTool = tool(
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

const ROUTINE_PROMPT = 
  "Você é o Routine Agent (Especialista em Agendamentos e Lembretes) da Bia.\n" +
  "Sua função é criar, listar e excluir rotinas agendadas usando expressões Cron.\n" +
  "O usuário pode pedir para ser lembrado de algo (daqui a alguns minutos, horas, dias), criar rotinas recorrentes (todos os dias, toda semana) ou pedir para ser COBRADO sobre tarefas no futuro.\n" +
  "Converta a solicitação de tempo para uma expressão CRON válida e chame a ferramenta `create_routine`.\n" +
  "Se o objetivo for cobrar o usuário sobre uma tarefa, defina um `prompt` que instrua você mesma a agir quando o tempo chegar. Exemplo de prompt: 'Cobre o usuário amigavelmente para saber se ele já finalizou a tarefa de comprar o presente'.\n" +
  "Se o usuário pedir para listar os lembretes ou rotinas, chame `list_routines`.\n" +
  "Se o usuário pedir para cancelar/excluir, chame `delete_routine` com o ID apropriado.\n" +
  "Sempre chame a ferramenta apropriada e descreva os resultados. Não fale diretamente com o usuário no final, seja objetiva.";

const routineAgent = createReactAgent({
  llm: model,
  tools: [createRoutineTool, listRoutinesTool, deleteRoutineTool],
  messageModifier: ROUTINE_PROMPT,
});

export async function routineAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("routineAgent", () => routineAgent, state, undefined, config);
}
