import { jest, describe, test, expect, afterEach } from '@jest/globals';
import cron from 'node-cron';
import { scheduleRoutine, descheduleRoutine, initRoutineManager, hasActiveJob } from "../../src/utils/routineManager.js";
import { Routine, saveRoutine, deleteRoutine, deactivateRoutine } from "../../src/memory/routines.js";
import { logger } from "../../src/utils/logger.js";

describe("Routine Manager Scheduler", () => {
  const dummyRoutine: Routine = {
    id: 99999,
    chatJid: "test-routine-mgr@s.whatsapp.net",
    cronExpression: "* * * * *",
    prompt: "Lembrete de teste de gerenciador",
    isActive: true
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("deve agendar uma nova rotina cron sem erros", () => {
    expect(() => scheduleRoutine(dummyRoutine)).not.toThrow();
    expect(hasActiveJob(dummyRoutine.id)).toBe(true);
  });

  test("deve desagendar a rotina", () => {
    expect(() => descheduleRoutine(dummyRoutine.id)).not.toThrow();
    expect(hasActiveJob(dummyRoutine.id)).toBe(false);
  });

  test("deve inicializar o gerenciador de rotinas", async () => {
    await expect(initRoutineManager()).resolves.not.toThrow();
  });

  test("deve desagendar e abortar disparo caso a rotina tenha sido excluída externamente do SQLite", async () => {
    let cronCallback: (() => Promise<void>) | null = null;
    jest.spyOn(cron, "schedule").mockImplementation((expr: string, cb: any) => {
      cronCallback = cb;
      return { stop: jest.fn(), start: jest.fn() } as any;
    });
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});

    // 1. Salva no banco e agenda
    const r = await saveRoutine("chat-deleted@s.whatsapp.net", "* * * * *", "Prompt teste deletado");
    scheduleRoutine(r);
    expect(hasActiveJob(r.id)).toBe(true);

    // 2. Simula deleção direta do banco (sem chamar descheduleRoutine)
    await deleteRoutine(r.id);

    // 3. O cron acorda e dispara o callback
    expect(cronCallback).not.toBeNull();
    await cronCallback!();

    // 4. Deve ter detectado ausência no banco, desagendado da memória e emitido aviso
    expect(hasActiveJob(r.id)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Rotina ID ${r.id} não encontrada ou inativa no banco de dados. Desagendando da memória.`)
    );
  });

  test("deve desagendar e abortar disparo caso a rotina esteja inativa (isActive = 0) no SQLite", async () => {
    let cronCallback: (() => Promise<void>) | null = null;
    jest.spyOn(cron, "schedule").mockImplementation((expr: string, cb: any) => {
      cronCallback = cb;
      return { stop: jest.fn(), start: jest.fn() } as any;
    });
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});

    // 1. Salva no banco e agenda
    const r = await saveRoutine("chat-deact@s.whatsapp.net", "* * * * *", "Prompt inativo");
    scheduleRoutine(r);
    expect(hasActiveJob(r.id)).toBe(true);

    // 2. Desativa no banco
    await deactivateRoutine(r.id);

    // 3. O cron acorda e dispara o callback
    expect(cronCallback).not.toBeNull();
    await cronCallback!();

    // 4. Deve ter detectado que está inativa, desagendado e emitido aviso
    expect(hasActiveJob(r.id)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Rotina ID ${r.id} não encontrada ou inativa no banco de dados. Desagendando da memória.`)
    );

    // Cleanup
    await deleteRoutine(r.id);
  });

  test("deve validar rotina ativa no banco e prosseguir com disparo", async () => {
    let cronCallback: (() => Promise<void>) | null = null;
    jest.spyOn(cron, "schedule").mockImplementation((expr: string, cb: any) => {
      cronCallback = cb;
      return { stop: jest.fn(), start: jest.fn() } as any;
    });
    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});

    const r = await saveRoutine("chat-active@s.whatsapp.net", "* * * * *", "Prompt ativo");
    scheduleRoutine(r);
    expect(hasActiveJob(r.id)).toBe(true);

    expect(cronCallback).not.toBeNull();
    await cronCallback!();

    expect(hasActiveJob(r.id)).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Disparando rotina ID ${r.id} para o chat ${r.chatJid}`)
    );

    // Cleanup
    descheduleRoutine(r.id);
    await deleteRoutine(r.id);
  });
});

