import { HumanMessage } from "@langchain/core/messages";
import { routineAgentNode, createRoutineTool, listRoutinesTool, deleteRoutineTool } from "../../src/agents/routineAgent.js";

describe("Routine Agent Node & Tool Handlers", () => {
  const testJid = "test-routine-agent-ext@s.whatsapp.net";
  let createdRoutineId: number;

  test("deve testar execução direta das ferramentas de rotinas", async () => {
    const config = { configurable: { thread_id: testJid } } as any;

    // Erro por falta de thread_id
    const errRes = await createRoutineTool.invoke({ cronExpression: "0 9 * * *", prompt: "Teste" }, {} as any);
    expect(String(errRes)).toContain("Erro");

    // Criar rotina
    const createRes = await createRoutineTool.invoke({ cronExpression: "0 9 * * *", prompt: "Verificar tarefas" }, config);
    expect(String(createRes)).toContain("Rotina criada com sucesso!");
    const match = String(createRes).match(/ID: (\d+)/);
    expect(match).not.toBeNull();
    createdRoutineId = parseInt(match![1]);

    // Listar rotinas
    const listRes = await listRoutinesTool.invoke({}, config);
    expect(String(listRes)).toContain("Verificar tarefas");

    // Excluir rotina
    const deleteRes = await deleteRoutineTool.invoke({ id: createdRoutineId }, config);
    expect(String(deleteRes)).toContain("cancelada com sucesso");
  });

  test("deve criar uma rotina agendada via agente", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Me lembre de olhar o forno todos os dias às 18h")],
      contextData: { chatJid: testJid, isTrustedChat: true }
    };

    const result = await routineAgentNode(initialState, { configurable: { thread_id: testJid } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
  }, 30000);
});
