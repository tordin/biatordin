import { jest, describe, test, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  runFollowUpScan,
  initFollowUpWorker,
  stopFollowUpWorker,
  formatWaitingAlertMessage,
  formatPromisedReminderMessage
} from '../../src/services/followUp/followUpWorker.js';
import {
  initFollowUpsTable,
  saveFollowUp as originalSaveFollowUp,
  getFollowUpById,
  updateFollowUp,
  deleteFollowUp,
  CreateFollowUpDTO
} from '../../src/memory/followUps.js';

describe('Follow-Up Background Worker', () => {
  let sentAlerts: string[] = [];
  let createdIds: number[] = [];

  const saveFollowUp = async (dto: CreateFollowUpDTO) => {
    const item = await originalSaveFollowUp(dto);
    if (item?.id) createdIds.push(item.id);
    return item;
  };

  const mockNotifier = async (text: string) => {
    sentAlerts.push(text);
  };

  beforeEach(async () => {
    await initFollowUpsTable();
    sentAlerts = [];
    createdIds = [];
  });

  afterEach(async () => {
    for (const id of createdIds) {
      try {
        await deleteFollowUp(id);
      } catch {}
    }
    createdIds = [];
  });

  test('deve formatar mensagens de alerta e lembrete corretamente', async () => {
    const waitingItem: any = {
      id: 1,
      contactName: 'Marcos',
      description: 'Orçamento do projeto',
      dueDate: new Date().toISOString()
    };
    const alertMsg = formatWaitingAlertMessage(waitingItem);
    expect(alertMsg).toContain('Marcos ainda não deu retorno sobre Orçamento do projeto');
    expect(alertMsg).toContain('Quer que eu envie uma mensagem educada de cobrança');

    const promisedItem: any = {
      id: 2,
      contactName: 'João',
      description: 'Enviar o contrato revisado',
      dueDate: new Date().toISOString()
    };
    const reminderMsg = formatPromisedReminderMessage(promisedItem);
    expect(reminderMsg).toContain('Lembrete: você combinou de Enviar o contrato revisado para João');
  });

  test('deve alertar o Luiz quando uma pendência de Waiting for Reply estiver vencida', async () => {
    const pastDueDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const created = await saveFollowUp({
      type: 'waiting_for_them',
      contactName: 'Marcos Fornecedor',
      description: 'Orçamento do projeto hidráulico',
      dueDate: pastDueDate
    });

    const stats = await runFollowUpScan(mockNotifier);
    expect(stats.overdueWaitingCount).toBeGreaterThanOrEqual(1);
    expect(stats.alertsSent).toBeGreaterThanOrEqual(1);

    expect(sentAlerts.some(msg => msg.includes('Marcos Fornecedor ainda não deu retorno sobre Orçamento do projeto hidráulico'))).toBe(true);
    expect(sentAlerts.some(msg => msg.includes('Quer que eu envie uma mensagem educada de cobrança'))).toBe(true);

    const updated = await getFollowUpById(created.id);
    expect(updated?.status).toBe('overdue');
    expect(updated?.lastNotifiedAt).not.toBeNull();
  });

  test('deve lembrar o Luiz quando um Promised by Me estiver com prazo próximo', async () => {
    const nearDueDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const created = await saveFollowUp({
      type: 'promised_by_me',
      contactName: 'João Advogado',
      description: 'Enviar o contrato revisado em PDF',
      dueDate: nearDueDate
    });

    const stats = await runFollowUpScan(mockNotifier);
    expect(stats.upcomingPromisedCount).toBeGreaterThanOrEqual(1);

    expect(sentAlerts.some(msg => msg.includes('Lembrete: você combinou de Enviar o contrato revisado em PDF para João Advogado'))).toBe(true);

    const updated = await getFollowUpById(created.id);
    expect(updated?.lastNotifiedAt).not.toBeNull();
  });

  test('não deve reenviar alertas duplicados se já foi notificado recentemente', async () => {
    const pastDueDate = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const created = await saveFollowUp({
      type: 'waiting_for_them',
      contactName: 'Ana Débora',
      description: 'Retorno do envio das fotos',
      dueDate: pastDueDate
    });

    // 1st scan
    const stats1 = await runFollowUpScan(mockNotifier);
    const count1 = sentAlerts.length;
    expect(count1).toBeGreaterThan(0);

    // 2nd scan immediately
    const stats2 = await runFollowUpScan(mockNotifier);
    expect(sentAlerts.length).toBe(count1);
    expect(stats2.alertsSent).toBe(0);
  });

  test('deve inicializar e desativar o worker sem erros', async () => {
    await expect(initFollowUpWorker()).resolves.not.toThrow();
    expect(() => stopFollowUpWorker()).not.toThrow();
  });
});
