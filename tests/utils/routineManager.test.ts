import { scheduleRoutine, descheduleRoutine, initRoutineManager } from "../../src/utils/routineManager.js";
import { Routine } from "../../src/memory/routines.js";

describe("Routine Manager Scheduler", () => {
  const dummyRoutine: Routine = {
    id: 99999,
    chatJid: "test-routine-mgr@s.whatsapp.net",
    cronExpression: "* * * * *",
    prompt: "Lembrete de teste de gerenciador",
    isActive: true
  };

  test("deve agendar uma nova rotina cron sem erros", () => {
    expect(() => scheduleRoutine(dummyRoutine)).not.toThrow();
  });

  test("deve desagendar a rotina", () => {
    expect(() => descheduleRoutine(dummyRoutine.id)).not.toThrow();
  });

  test("deve inicializar o gerenciador de rotinas", async () => {
    await expect(initRoutineManager()).resolves.not.toThrow();
  });
});
