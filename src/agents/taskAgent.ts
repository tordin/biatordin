import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { saveTask, getTasksForChat, markTaskCompleted, deleteTask } from "../memory/tasks.js";
import { saveFollowUp, getFollowUps, resolveFollowUp } from "../memory/followUps.js";
import { getSkill } from "../skills/registry.js";

export const addTaskTool = tool(
  async ({ title, category, urgency, dueDate }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat (thread_id ausente).";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");
    const topicId = config?.configurable?.contextData?.activeTopicId;

    try {
      const task = await saveTask(chatJid, title, category || "Geral", urgency || "Média", dueDate, topicId);

      // Se a tarefa envolve um terceiro ou compromisso externo com prazo, registra follow-up automático
      const lowerTitle = title.toLowerCase();
      const isPromised = lowerTitle.startsWith('enviar') || lowerTitle.startsWith('mandar') || lowerTitle.startsWith('passar') || lowerTitle.startsWith('entregar');
      const isWaiting = lowerTitle.startsWith('cobrar') || lowerTitle.startsWith('aguardar') || lowerTitle.startsWith('esperar');

      if ((isPromised || isWaiting) && dueDate) {
        const contactExtract = title.split(/para|pro|pra|ao|do|da|de/i)[1]?.trim() || 'Contato da Tarefa';
        saveFollowUp({
          type: isPromised ? 'promised_by_me' : 'waiting_for_them',
          contactName: contactExtract,
          description: title,
          dueDate: dueDate,
          contextOrigin: 'direct',
          chatJid: chatJid
        }).catch(e => logger.warn('[TASK AGENT] Falha ao sincronizar follow-up da tarefa:', e));
      }

      return `✅ Tarefa criada com sucesso! ID: ${task.id} | Título: "${task.title}" | Categoria: ${task.category} | Urgência: ${task.urgency}${task.dueDate ? ` | Prazo: ${task.dueDate}` : ""}`;
    } catch (err: any) {
      logger.error("Erro ao adicionar tarefa:", err);
      return `Erro ao salvar tarefa no banco de dados: ${err.message}`;
    }
  },
  {
    name: "add_task",
    description: "Adiciona uma nova tarefa ou item de lista para o usuário. Permite definir título, categoria (ex: Casa, Trabalho, Vendas), urgência (Alta/Média/Baixa) e data/prazo.",
    schema: z.object({
      title: z.string().describe("O título ou descrição detalhada da tarefa (ex: 'Resolver situação do piscineiro', 'Vender Macbook Air M2')."),
      category: z.string().optional().describe("Categoria opcional da tarefa (ex: 'Casa', 'Trabalho', 'Vendas', 'Geral')."),
      urgency: z.enum(["Baixa", "Média", "Alta"]).optional().describe("Nível de urgência da tarefa. Padrão: 'Média'."),
      dueDate: z.string().optional().describe("Data ou prazo limite opcional para a tarefa (ex: '2026-07-25' ou 'próxima segunda').")
    })
  }
);

export const listTasksTool = tool(
  async ({ status, category }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat.";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");

    try {
      const tasks = await getTasksForChat(chatJid, status || "pending", category);
      if (tasks.length === 0) {
        return `Nenhuma tarefa ${status === 'completed' ? 'concluída' : 'pendente'} encontrada.`;
      }

      const formattedList = tasks.slice(0, 30).map(t => 
        `- [${t.isCompleted ? 'x' : ' '}] ID ${t.id}: ${t.title} (${t.category}${t.dueDate ? `, Prazo: ${t.dueDate}` : ''})`
      ).join("\n");
      const extra = tasks.length > 30 ? `\n...e mais ${tasks.length - 30} tarefas ocultas.` : "";

      return `<RAW_TOOL_OUTPUT source="sqlite:tasks">\nLista de Tarefas:\n${formattedList}${extra}\n</RAW_TOOL_OUTPUT>`;
    } catch (err: any) {
      logger.error("Erro ao listar tarefas:", err);
      return `Erro ao consultar tarefas no banco de dados: ${err.message}`;
    }
  },
  {
    name: "list_tasks",
    description: "Lista as tarefas do usuário cadastradas no sistema. Pode filtrar por status ('pending', 'completed', 'all') e categoria.",
    schema: z.object({
      status: z.enum(["pending", "completed", "all"]).optional().describe("Filtro de status. 'pending' para pendentes (padrão), 'completed' para concluídas, 'all' para todas."),
      category: z.string().optional().describe("Filtro por palavra-chave da categoria (ex: 'Casa', 'Vendas').")
    })
  }
);

export const completeTaskTool = tool(
  async ({ id }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat.";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");

    try {
      const success = await markTaskCompleted(id, chatJid);
      if (success) {
        return `✅ Tarefa ID ${id} foi marcada como concluída!`;
      } else {
        return `Tarefa ID ${id} não encontrada ou já concluída.`;
      }
    } catch (err: any) {
      logger.error("Erro ao concluir tarefa:", err);
      return `Erro ao atualizar tarefa: ${err.message}`;
    }
  },
  {
    name: "complete_task",
    description: "Marca uma tarefa como concluída pelo seu ID numérico.",
    schema: z.object({
      id: z.number().describe("O ID numérico da tarefa a ser concluída.")
    })
  }
);

export const deleteTaskTool = tool(
  async ({ id }, config) => {
    const threadId = config?.configurable?.thread_id;
    if (!threadId) return "Erro: não foi possível identificar o chat.";
    const chatJid = config?.configurable?.contextData?.chatJid;
    if (!chatJid) throw new Error("chatJid is required in contextData");

    try {
      const success = await deleteTask(id, chatJid);
      if (success) {
        return `🗑️ Tarefa ID ${id} foi excluída com sucesso.`;
      } else {
        return `Tarefa ID ${id} não foi encontrada.`;
      }
    } catch (err: any) {
      logger.error("Erro ao excluir tarefa:", err);
      return `Erro ao excluir tarefa: ${err.message}`;
    }
  },
  {
    name: "delete_task",
    description: "Exclui definitivamente uma tarefa pelo seu ID numérico.",
    schema: z.object({
      id: z.number().describe("O ID numérico da tarefa a ser excluída.")
    })
  }
);

const TASK_PROMPT = getSkill("taskAgent")?.detailedPrompt || 
  "Você é o Agente de Gestão de Tarefas (Task Manager) da Bia.\n" +
  "Sua função principal é adicionar, listar, concluir e excluir tarefas e listas de afazeres do usuário utilizando o banco de dados de tarefas.\n" +
  "Sempre use as ferramentas apropriadas (`add_task`, `list_tasks`, `complete_task`, `delete_task`).\n" +
  "Seja objetivo e informe os resultados com clareza.";

const taskAgent = createReactAgent({
  llm: model,
  tools: [addTaskTool, listTasksTool, completeTaskTool, deleteTaskTool],
  messageModifier: TASK_PROMPT,
});

export async function taskAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("taskAgent", () => taskAgent, state, undefined, config);
}
