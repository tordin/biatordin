import { HumanMessage } from "@langchain/core/messages";
import {
  emailSentinelAgentNode,
  addSentinelRuleTool,
  listSentinelRulesTool,
  deleteSentinelRuleTool,
  checkInboxNowTool,
  getSentinelLogsTool,
  checkGoogleAuthStatusTool,
} from "../../src/agents/emailSentinelAgent.js";
import { initEmailSentinelTables } from "../../src/memory/emailSentinel.js";

describe("Email Sentinel Agent & Tool Handlers", () => {
  const testJid = "5519997064504@s.whatsapp.net";
  let createdRuleId: number;

  beforeAll(async () => {
    await initEmailSentinelTables();
  });

  test("deve testar execução direta das ferramentas do sentinela", async () => {
    const config = { configurable: { thread_id: testJid, contextData: { chatJid: testJid } } } as any;

    // 1. Adicionar regra de ignore
    const addIgnoreRes = await addSentinelRuleTool.invoke(
      {
        type: "ignore",
        pattern: "loja abc",
        target: "sender",
        reason: "Nunca avisar de promoções",
      },
      config
    );
    expect(String(addIgnoreRes)).toContain("Regra do Sentinela cadastrada com sucesso!");
    expect(String(addIgnoreRes)).toContain("loja abc");

    const match = String(addIgnoreRes).match(/\[ID: (\d+)\]/);
    expect(match).not.toBeNull();
    createdRuleId = parseInt(match![1]);

    // 2. Adicionar regra de prioridade
    const addPriorityRes = await addSentinelRuleTool.invoke(
      {
        type: "priority",
        pattern: "condomínio solar",
        target: "subject",
        reason: "Avisos importantes do prédio",
      },
      config
    );
    expect(String(addPriorityRes)).toContain("Prioridade Alta");

    // 3. Listar regras
    const listRes = await listSentinelRulesTool.invoke({}, config);
    expect(String(listRes)).toContain("Regras do Sentinela de E-mails:");
    expect(String(listRes)).toContain("loja abc");

    // 4. Testar disparo manual de varredura
    const checkRes = await checkInboxNowTool.invoke({ maxResults: 10 }, config);
    expect(String(checkRes)).toContain("Varredura do Sentinela de E-mail concluída!");

    // 5. Consultar logs do sentinela
    const logsRes = await getSentinelLogsTool.invoke({ limit: 10 }, config);
    expect(String(logsRes)).toContain("Estatísticas do Sentinela");

    // 6. Testar verificação de autenticação do Google
    const authStatusRes = await checkGoogleAuthStatusTool.invoke({}, config);
    expect(String(authStatusRes)).toContain("Status da Autenticação do Google");

    // 7. Excluir regra
    const deleteRes = await deleteSentinelRuleTool.invoke({ id: createdRuleId }, config);
    expect(String(deleteRes)).toContain("excluída com sucesso");
  });

  test("deve validar schemas e metadados de todas as ferramentas do sentinela", () => {
    expect(addSentinelRuleTool.name).toBe("add_sentinel_rule");
    expect(listSentinelRulesTool.name).toBe("list_sentinel_rules");
    expect(deleteSentinelRuleTool.name).toBe("delete_sentinel_rule");
    expect(checkInboxNowTool.name).toBe("check_inbox_now");
    expect(getSentinelLogsTool.name).toBe("get_sentinel_logs");
    expect(checkGoogleAuthStatusTool.name).toBe("check_google_auth_status");

    expect(addSentinelRuleTool.description).toContain("Sentinela");
    expect(listSentinelRulesTool.description).toContain("Sentinela");
    expect(deleteSentinelRuleTool.description).toContain("Sentinela");
    expect(checkInboxNowTool.description).toContain("Gmail");
    expect(getSentinelLogsTool.description).toContain("Sentinela");
    expect(checkGoogleAuthStatusTool.description).toContain("Google");
  });
});
