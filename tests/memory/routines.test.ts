import { 
  saveRoutine, 
  getAllActiveRoutines, 
  getRoutinesForChat, 
  getRoutineById,
  updateRoutine,
  deleteRoutine, 
  deactivateRoutine 
} from "../../src/memory/routines.js";

describe("Routines SQLite Storage", () => {
  const testJid = "test-routines-chat@s.whatsapp.net";
  let createdRoutineId: number;

  test("deve salvar uma nova rotina agendada", async () => {
    const routine = await saveRoutine(testJid, "0 9 * * *", "Lembrar de tomar o remédio");
    expect(routine).toBeDefined();
    expect(routine.id).toBeGreaterThan(0);
    expect(routine.cronExpression).toBe("0 9 * * *");
    expect(routine.prompt).toBe("Lembrar de tomar o remédio");
    expect(routine.isActive).toBe(true);
    createdRoutineId = routine.id;
  });

  test("deve buscar rotina por ID", async () => {
    const found = await getRoutineById(createdRoutineId);
    expect(found).toBeDefined();
    expect(found?.id).toBe(createdRoutineId);
    expect(found?.prompt).toBe("Lembrar de tomar o remédio");
  });

  test("deve atualizar o prompt e cron de uma rotina", async () => {
    const updated = await updateRoutine(createdRoutineId, {
      cronExpression: "0 10 * * *",
      prompt: "Lembrar de tomar o remédio e medir a pressão"
    });
    expect(updated).toBeDefined();
    expect(updated?.cronExpression).toBe("0 10 * * *");
    expect(updated?.prompt).toBe("Lembrar de tomar o remédio e medir a pressão");
  });

  test("deve listar rotinas ativas por chat", async () => {
    const routines = await getRoutinesForChat(testJid);
    expect(routines.length).toBeGreaterThanOrEqual(1);
    expect(routines.some(r => r.id === createdRoutineId)).toBe(true);
  });

  test("deve recuperar todas as rotinas ativas do sistema", async () => {
    const all = await getAllActiveRoutines();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.some(r => r.id === createdRoutineId)).toBe(true);
  });

  test("deve desativar uma rotina", async () => {
    await deactivateRoutine(createdRoutineId);
    const routines = await getRoutinesForChat(testJid);
    expect(routines.some(r => r.id === createdRoutineId)).toBe(false);
  });

  test("deve excluir uma rotina", async () => {
    const newRoutine = await saveRoutine(testJid, "0 12 * * *", "Rotina para deletar");
    await deleteRoutine(newRoutine.id);
    const routines = await getRoutinesForChat(testJid);
    expect(routines.some(r => r.id === newRoutine.id)).toBe(false);
  });
});
