import {
  initEmailSentinelTables,
  addSentinelRule,
  getSentinelRules,
  deleteSentinelRule,
  isEmailProcessed,
  areEmailsProcessed,
  recordProcessedEmail,
  recordProcessedEmailsBatch,
  getRecentProcessedEmails,
  getSentinelStats,
} from "../../src/memory/emailSentinel.js";

describe("Email Sentinel Memory & SQLite Rules", () => {
  beforeAll(async () => {
    await initEmailSentinelTables();
  });

  test("deve cadastrar, listar e excluir regras de descarte e prioridade", async () => {
    // 1. Cadastrar regra de descarte (ignore)
    const ignoreRule = await addSentinelRule(
      "ignore",
      "loja submarino",
      "sender",
      "Nunca mais avisar sobre promoções da loja"
    );
    expect(ignoreRule).toBeDefined();
    expect(ignoreRule.id).toBeGreaterThan(0);
    expect(ignoreRule.type).toBe("ignore");
    expect(ignoreRule.pattern).toBe("loja submarino");
    expect(ignoreRule.target).toBe("sender");

    // 2. Cadastrar regra de prioridade
    const priorityRule = await addSentinelRule(
      "priority",
      "escola da cecília",
      "general",
      "Comunicados urgentes da escola da filha"
    );
    expect(priorityRule).toBeDefined();
    expect(priorityRule.type).toBe("priority");
    expect(priorityRule.pattern).toBe("escola da cecília");

    // 3. Listar todas as regras
    const allRules = await getSentinelRules();
    expect(allRules.length).toBeGreaterThanOrEqual(2);
    expect(allRules.some(r => r.id === ignoreRule.id)).toBe(true);
    expect(allRules.some(r => r.id === priorityRule.id)).toBe(true);

    // 4. Filtrar regras por tipo
    const ignoreRulesOnly = await getSentinelRules("ignore");
    expect(ignoreRulesOnly.every(r => r.type === "ignore")).toBe(true);

    const priorityRulesOnly = await getSentinelRules("priority");
    expect(priorityRulesOnly.every(r => r.type === "priority")).toBe(true);

    // 5. Excluir regras cadastradas
    const deletedIgnore = await deleteSentinelRule(ignoreRule.id);
    expect(deletedIgnore).toBe(true);

    const deletedPriority = await deleteSentinelRule(priorityRule.id);
    expect(deletedPriority).toBe(true);

    const deletedNonExistent = await deleteSentinelRule(999999);
    expect(deletedNonExistent).toBe(false);
  });

  test("deve gerenciar histórico de e-mails processados e deduplicação", async () => {
    const testEmailId1 = `test_msg_${Date.now()}_1`;
    const testEmailId2 = `test_msg_${Date.now()}_2`;

    // 1. Inicialmente não estão processados
    expect(await isEmailProcessed(testEmailId1)).toBe(false);
    expect(await isEmailProcessed(testEmailId2)).toBe(false);

    // 2. Registrar um e-mail individual
    await recordProcessedEmail({
      emailId: testEmailId1,
      threadId: "thread_123",
      sender: "diretoria@escola.com",
      subject: "Reunião de Pais",
      snippet: "Lembramos da reunião amanhã às 19h.",
      classification: "important",
      reason: "Reunião escolar prioritária",
    });

    expect(await isEmailProcessed(testEmailId1)).toBe(true);

    // 3. Registrar em lote
    await recordProcessedEmailsBatch([
      {
        emailId: testEmailId2,
        threadId: "thread_456",
        sender: "newsletter@promo.com",
        subject: "Super Descontos de Verão",
        snippet: "Confira nossas ofertas imperdíveis.",
        classification: "ignored_heuristic",
        reason: "Marketing descartado",
      },
    ]);

    expect(await isEmailProcessed(testEmailId2)).toBe(true);

    // 4. Verificação em lote com areEmailsProcessed
    const processedSet = await areEmailsProcessed([testEmailId1, testEmailId2, "unprocessed_id"]);
    expect(processedSet.has(testEmailId1)).toBe(true);
    expect(processedSet.has(testEmailId2)).toBe(true);
    expect(processedSet.has("unprocessed_id")).toBe(false);

    // 5. Consultar logs recentes
    const recentLogs = await getRecentProcessedEmails(10);
    expect(recentLogs.length).toBeGreaterThanOrEqual(2);
    expect(recentLogs.some(l => l.emailId === testEmailId1)).toBe(true);

    // 6. Consultar estatísticas agregadas
    const stats = await getSentinelStats();
    expect(stats.totalProcessed).toBeGreaterThanOrEqual(2);
    expect(stats.important).toBeGreaterThanOrEqual(1);
    expect(stats.ignoredHeuristic).toBeGreaterThanOrEqual(1);
  });
});
