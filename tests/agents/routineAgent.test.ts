import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { routineAgentNode, routineAgent, createRoutineTool, updateRoutineTool, listRoutinesTool, deleteRoutineTool } from "../../src/agents/routineAgent.js";

describe("Routine Agent Node & Tool Handlers", () => {
  const testJid = "test-routine-agent-ext@s.whatsapp.net";
  let createdRoutineId: number;

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test("deve validar schemas e metadados das ferramentas de rotinas", () => {
    expect(createRoutineTool.name).toBe("create_routine");
    expect(updateRoutineTool.name).toBe("update_routine");
    expect(listRoutinesTool.name).toBe("list_routines");
    expect(deleteRoutineTool.name).toBe("delete_routine");
  });

  test("deve criar uma rotina agendada via agente", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Me lembre de olhar o forno todos os dias às 18h")],
      contextData: { chatJid: testJid, isTrustedChat: true }
    };

    jest.spyOn(routineAgent, "invoke").mockImplementation(async (input: any) => ({
      messages: [...input.messages, new AIMessage("Rotina agendada com sucesso!")]
    } as any));

    const result = await routineAgentNode(initialState, { configurable: { thread_id: testJid } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
  });
});
