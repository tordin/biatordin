/**
 * Testes do FollowUp Agent com isolamento total do banco de produção.
 *
 * HISTÓRICO DO PROBLEMA: estes testes executavam as tools reais contra o
 * `database.sqlite` real, poluindo o banco com dados falsos (Marcenaria Silva,
 * Roberto, Carlos Pintor, etc.). A solução definitiva é mockar o módulo de
 * memória (`followUps.js`) com um store em memória via `jest.unstable_mockModule`
 * (API oficial de mock para ESM — `jest.mock` com factory não intercepta em
 * `--experimental-vm-modules`).
 */
import { jest, describe, test, expect } from '@jest/globals';

// ── Mock do módulo de memória (100% em memória, zero acesso ao SQLite real) ──
jest.unstable_mockModule("../../src/memory/followUps.js", () => {
  const store = new Map<number, any>();
  let nextId = 1;

  return {
    initFollowUpsTable: jest.fn(async () => {}),
    saveFollowUp: jest.fn(async (data: any) => {
      const item = {
        id: nextId++,
        ...data,
        status: data.status || 'pending',
        contextOrigin: data.contextOrigin || 'direct',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      store.set(item.id, item);
      return item;
    }),
    getFollowUpById: jest.fn(async (id: number) => store.get(id) || null),
    getFollowUps: jest.fn(async (filters: any = {}) => {
      let rows = [...store.values()];
      if (filters.type && filters.type !== 'all') {
        rows = rows.filter(r => r.type === filters.type);
      }
      if (filters.status && filters.status !== 'all') {
        if (filters.status === 'active') {
          rows = rows.filter(r => ['pending', 'overdue'].includes(r.status));
        } else {
          rows = rows.filter(r => r.status === filters.status);
        }
      }
      if (filters.contactName) {
        rows = rows.filter(r =>
          String(r.contactName).toLowerCase().includes(String(filters.contactName).toLowerCase())
        );
      }
      return rows;
    }),
    updateFollowUp: jest.fn(async (id: number, updates: any) => {
      const item = store.get(id);
      if (!item) return false;
      Object.assign(item, updates, { updatedAt: new Date().toISOString() });
      return true;
    }),
    resolveFollowUp: jest.fn(async (id: number, notes?: string) => {
      const item = store.get(id);
      if (!item || item.status === 'resolved') return false;
      item.status = 'resolved';
      if (notes) item.notes = item.notes ? `${item.notes}\n${notes}` : notes;
      item.updatedAt = new Date().toISOString();
      return true;
    }),
    cancelFollowUp: jest.fn(async (id: number, notes?: string) => {
      const item = store.get(id);
      if (!item || item.status === 'cancelled') return false;
      item.status = 'cancelled';
      if (notes) item.notes = item.notes ? `${item.notes}\n${notes}` : notes;
      item.updatedAt = new Date().toISOString();
      return true;
    }),
    markFollowUpNotified: jest.fn(async () => true),
    getOverdueWaitingFollowUps: jest.fn(async () => []),
    getUpcomingPromisedFollowUps: jest.fn(async () => []),
    autoResolveFollowUpsForChat: jest.fn(async () => []),
    deleteFollowUp: jest.fn(async (id: number) => store.delete(id))
  };
});

// Import dinâmico OBRIGATÓRIO após unstable_mockModule
const {
  followUpAgentNode,
  addFollowUpTool,
  listFollowUpsTool,
  resolveFollowUpTool,
  cancelFollowUpTool,
  updateFollowUpTool
} = await import("../../src/agents/followUpAgent.js");

describe("FollowUp Agent Node & Tool Handlers (isolado do banco)", () => {
  const testJid = "test-followup-agent@s.whatsapp.net";
  let createdWaitingId: number;
  let createdPromisedId: number;

  test("deve testar execução direta das ferramentas do followUpAgent", async () => {
    const config = {
      configurable: {
        thread_id: "main_test-followup@s.whatsapp.net_topic1",
        contextData: { chatJid: testJid }
      }
    } as any;

    // 1. Adicionar waiting_for_them
    const addWaiting = await addFollowUpTool.invoke({
      type: "waiting_for_them",
      contactName: "Marcenaria Silva",
      contactNumber: "19999998888",
      description: "Orçamento do armário planejado",
      dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }, config);

    expect(String(addWaiting)).toContain("✅ Pendência de Follow-Up registrada com sucesso!");
    expect(String(addWaiting)).toContain("Marcenaria Silva");
    const matchW = String(addWaiting).match(/ID: (\d+)/);
    expect(matchW).not.toBeNull();
    createdWaitingId = parseInt(matchW![1]);

    // 2. Adicionar promised_by_me
    const addPromised = await addFollowUpTool.invoke({
      type: "promised_by_me",
      contactName: "Roberto",
      description: "Enviar comprovante do Pix",
      dueDate: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    }, config);

    expect(String(addPromised)).toContain("Promised by Me");
    const matchP = String(addPromised).match(/ID: (\d+)/);
    expect(matchP).not.toBeNull();
    createdPromisedId = parseInt(matchP![1]);

    // 3. Listar pendências ativas
    const listRes = await listFollowUpsTool.invoke({ status: "active" }, config);
    expect(String(listRes)).toContain("Marcenaria Silva");
    expect(String(listRes)).toContain("Roberto");

    // 4. Listar apenas waiting_for_them
    const listWaitingOnly = await listFollowUpsTool.invoke({ type: "waiting_for_them" }, config);
    expect(String(listWaitingOnly)).toContain("Marcenaria Silva");

    // 5. Atualizar pendência
    const newDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const updateRes = await updateFollowUpTool.invoke({
      id: createdWaitingId,
      dueDate: newDate,
      notes: "Marcenaria pediu mais 24h para finalizar"
    }, config);
    expect(String(updateRes)).toContain("atualizada com sucesso");

    // 6. Concluir / Resolver pendência
    const resolveRes = await resolveFollowUpTool.invoke({
      id: createdWaitingId,
      notes: "Orçamento recebido com sucesso no valor de R$ 4.500"
    }, config);
    expect(String(resolveRes)).toContain("marcada como resolvida");

    // 7. Cancelar pendência
    const cancelRes = await cancelFollowUpTool.invoke({
      id: createdPromisedId,
      notes: "Cancelado porque o Pix já caiu direto"
    }, config);
    expect(String(cancelRes)).toContain("cancelada com sucesso");
  });

  test("deve resolver pendência buscando por nome do contato", async () => {
    const config = { configurable: { thread_id: testJid } } as any;

    await addFollowUpTool.invoke({
      type: "waiting_for_them",
      contactName: "Carlos Pintor",
      description: "Data para iniciar a pintura"
    }, config);

    const resolveByName = await resolveFollowUpTool.invoke({
      contactName: "Carlos Pintor",
      notes: "Carlos confirmou que inicia segunda-feira"
    }, config);

    expect(String(resolveByName)).toContain("marcada como resolvida");
  });

  test("followUpAgentNode deve estar definido e ser função", () => {
    expect(typeof followUpAgentNode).toBe("function");
  });
});
