import { HumanMessage } from "@langchain/core/messages";
import { taskAgentNode, addTaskTool, listTasksTool, completeTaskTool, deleteTaskTool } from "../../src/agents/taskAgent.js";

describe("Task Agent Node & Tool Handlers", () => {
  const testJid = "test-task-agent-ext@s.whatsapp.net";
  let createdTaskId: number;

  test("deve testar execução direta das ferramentas de tarefas", async () => {
    const config = { configurable: { thread_id: testJid } } as any;

    // Teste de add_task sem thread_id
    const errAdd = await addTaskTool.invoke({ title: "Sem chat" }, {} as any);
    expect(String(errAdd)).toContain("Erro");

    // Adicionar tarefa com sucesso
    const addRes = await addTaskTool.invoke({ title: "Comprar lâmpadas LED", category: "Casa", urgency: "Alta" }, config);
    expect(String(addRes)).toContain("✅ Tarefa criada com sucesso!");
    const match = String(addRes).match(/ID: (\d+)/);
    expect(match).not.toBeNull();
    createdTaskId = parseInt(match![1]);

    // Listar tarefas
    const listRes = await listTasksTool.invoke({ status: "pending" }, config);
    expect(String(listRes)).toContain("Comprar lâmpadas LED");

    // Concluir tarefa
    const completeRes = await completeTaskTool.invoke({ id: createdTaskId }, config);
    expect(completeRes).toContain("marcada como concluída");

    // Excluir tarefa
    const deleteRes = await deleteTaskTool.invoke({ id: createdTaskId }, config);
    expect(deleteRes).toContain("excluída com sucesso");
  });

  test("deve processar mensagem de usuário pelo agente", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Adicione a tarefa 'Comprar ração para os gatos' na categoria Casa")],
      contextData: { chatJid: testJid, isTrustedChat: true }
    };

    const result = await taskAgentNode(initialState, { configurable: { thread_id: testJid } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
  }, 30000);
});
