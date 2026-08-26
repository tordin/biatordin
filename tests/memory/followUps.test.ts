import { describe, test, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  initFollowUpsTable,
  saveFollowUp as originalSaveFollowUp,
  getFollowUpById,
  getFollowUps,
  updateFollowUp,
  resolveFollowUp,
  cancelFollowUp,
  deleteFollowUp,
  markFollowUpNotified,
  getOverdueWaitingFollowUps,
  getUpcomingPromisedFollowUps,
  autoResolveFollowUpsForChat,
  FollowUp,
  CreateFollowUpDTO
} from '../../src/memory/followUps.js';

describe('Follow-Ups SQLite Memory Module', () => {
  let createdIds: number[] = [];

  const saveFollowUp = async (dto: CreateFollowUpDTO) => {
    const item = await originalSaveFollowUp(dto);
    if (item?.id) createdIds.push(item.id);
    return item;
  };

  beforeEach(async () => {
    await initFollowUpsTable();
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

  test('deve criar e recuperar uma pendência de Waiting for Reply (waiting_for_them)', async () => {
    const created = await saveFollowUp({
      type: 'waiting_for_them',
      contactName: 'Marcos Silva',
      contactJid: '5519999990001@s.whatsapp.net',
      description: 'Orçamento da reforma da piscina',
      dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      contextOrigin: 'direct',
      chatJid: '5519999990001@s.whatsapp.net'
    });

    expect(created).toBeDefined();
    expect(created.id).toBeGreaterThan(0);
    expect(created.type).toBe('waiting_for_them');
    expect(created.contactName).toBe('Marcos Silva');
    expect(created.status).toBe('pending');

    const retrieved = await getFollowUpById(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.description).toBe('Orçamento da reforma da piscina');
  });

  test('deve criar e recuperar uma promessa do Luiz (promised_by_me)', async () => {
    const created = await saveFollowUp({
      type: 'promised_by_me',
      contactName: 'João Santos',
      contactJid: '5519999990002@s.whatsapp.net',
      description: 'Enviar contrato revisado em PDF',
      dueDate: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      contextOrigin: 'direct'
    });

    expect(created).toBeDefined();
    expect(created.type).toBe('promised_by_me');
    expect(created.status).toBe('pending');
  });

  test('deve filtrar pendências por tipo, status e nome do contato', async () => {
    const uniqueSuffix = Date.now().toString();
    await saveFollowUp({
      type: 'waiting_for_them',
      contactName: `Fornecedor_${uniqueSuffix}`,
      description: 'Proposta comercial A'
    });

    await saveFollowUp({
      type: 'promised_by_me',
      contactName: `Cliente_${uniqueSuffix}`,
      description: 'Enviar relatório financeiro B'
    });

    const waitingList = await getFollowUps({ type: 'waiting_for_them', contactName: uniqueSuffix });
    expect(waitingList.length).toBe(1);
    expect(waitingList[0].contactName).toContain(`Fornecedor_${uniqueSuffix}`);

    const promisedList = await getFollowUps({ type: 'promised_by_me', contactName: uniqueSuffix });
    expect(promisedList.length).toBe(1);
    expect(promisedList[0].contactName).toContain(`Cliente_${uniqueSuffix}`);
  });

  test('deve marcar pendência como resolvida', async () => {
    const created = await saveFollowUp({
      type: 'waiting_for_them',
      contactName: 'Luciana',
      description: 'Retorno sobre o evento'
    });

    const ok = await resolveFollowUp(created.id, 'Resolvido após ligação');
    expect(ok).toBe(true);

    const updated = await getFollowUpById(created.id);
    expect(updated?.status).toBe('resolved');
    expect(updated?.notes).toContain('Resolvido após ligação');
  });

  test('deve marcar pendência como cancelada', async () => {
    const created = await saveFollowUp({
      type: 'promised_by_me',
      contactName: 'Pedro',
      description: 'Enviar tabela descontinuada'
    });

    const ok = await cancelFollowUp(created.id, 'Cancelado pois o item não existe mais');
    expect(ok).toBe(true);

    const updated = await getFollowUpById(created.id);
    expect(updated?.status).toBe('cancelled');
  });

  test('deve identificar pendências waiting_for_them vencidas e promised_by_me próximas', async () => {
    const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const nearFuture = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const overdueItem = await saveFollowUp({
      type: 'waiting_for_them',
      contactName: 'Carlos Atrasado',
      description: 'Retorno da proposta que venceu há 1 hora',
      dueDate: pastDate
    });

    const nearItem = await saveFollowUp({
      type: 'promised_by_me',
      contactName: 'Beatriz Próxima',
      description: 'Enviar comprovante nas próximas 2 horas',
      dueDate: nearFuture
    });

    const overdues = await getOverdueWaitingFollowUps();
    const foundOverdue = overdues.find(f => f.id === overdueItem.id);
    expect(foundOverdue).toBeDefined();

    const upcoming = await getUpcomingPromisedFollowUps(4);
    const foundUpcoming = upcoming.find(f => f.id === nearItem.id);
    expect(foundUpcoming).toBeDefined();
  });

  test('deve auto-resolver pendência quando o contato responde no chat', async () => {
    const targetJid = `55198888${Date.now().toString().slice(-4)}@s.whatsapp.net`;
    const created = await saveFollowUp({
      type: 'waiting_for_them',
      contactName: 'Mariana Respondeu',
      contactJid: targetJid,
      description: 'Confirmação de presença no jantar',
      chatJid: targetJid
    });

    const resolved = await autoResolveFollowUpsForChat(targetJid, targetJid, 'Mariana Respondeu', 'Oi Luiz, confirmo sim!');
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(resolved.some(r => r.id === created.id)).toBe(true);

    const check = await getFollowUpById(created.id);
    expect(check?.status).toBe('resolved');
    expect(check?.notes).toContain('[AUTO-RESOLVIDO]');
  });
});
