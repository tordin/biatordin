import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { taskAgentNode, taskAgent, addTaskTool, listTasksTool, completeTaskTool, deleteTaskTool } from "../../src/agents/taskAgent.js";

describe("Task Agent Node & Tool Handlers", () => {
  const testJid = "test-task-agent-ext@s.whatsapp.net";
  let createdTaskId: number;

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test("deve validar schemas e metadados das ferramentas de tarefas", () => {
    expect(addTaskTool.name).toBe("add_task");
    expect(listTasksTool.name).toBe("list_tasks");
    expect(completeTaskTool.name).toBe("complete_task");
    expect(deleteTaskTool.name).toBe("delete_task");
  });

  test("deve processar mensagem de usuário pelo agente", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Adicione a tarefa 'Comprar ração para os gatos' na categoria Casa")],
      contextData: { chatJid: testJid, isTrustedChat: true }
    };

    jest.spyOn(taskAgent, "invoke").mockImplementation(async (input: any) => ({
      messages: [...input.messages, new AIMessage("Tarefa anotada com sucesso!")]
    } as any));

    const result = await taskAgentNode(initialState, { configurable: { thread_id: testJid } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
  });
});
