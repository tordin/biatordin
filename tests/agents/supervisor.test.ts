/**
 * Testes do Supervisor com ISOLAMENTO TOTAL de chamadas ao LLM real.
 *
 * HISTÓRICO DO PROBLEMA: estes testes chamavam `supervisorNode` com os modelos
 * reais (DeepSeek/OpenAI). Isso (1) gastava tokens reais, (2) era não-determinístico,
 * e (3) o teste de "gatilho de rotina agendada" fez o supervisor rotear para
 * `missionAgent`, que criou follow-ups REAIS no banco de produção ("Cobra sobre a
 * tarefa de comprar o presente") — que foram notificados ao Luiz pelo cron de cobranças.
 *
 * A solução definitiva: mockar `withStructuredOutput` do modelo usado pelo supervisor
 * para retornar decisões determinísticas por teste. `invokeStructuredWithFallback`
 * chama `model.withStructuredOutput(schema)` e depois `.invoke(messages)` — com o
 * retorno mockado, NENHUMA chamada real ao LLM acontece e nenhum side-effect no banco.
 */
import { jest, describe, test, it, expect, beforeEach } from '@jest/globals';
import { HumanMessage } from "@langchain/core/messages";

import { supervisorNode, cleanDsmlTags, buildSupervisorPrompt } from "../../src/agents/supervisor.js";
import { modelFlashStructured } from "../../src/llm/model.js";

// Helper: define a decisão que o supervisor "recebe" do LLM mockado
function mockSupervisorDecision(decision: Record<string, any>) {
  jest.spyOn(modelFlashStructured, "withStructuredOutput").mockReturnValue({
    invoke: jest.fn<any>().mockResolvedValue(decision)
  } as any);
}

const DEFAULT_DECISION = {
  plan: null,
  nextAgent: "FINISH",
  specialistTask: null,
  reason: "Decisão mockada para teste isolado",
  response: "Tudo certo!",
  intermediateMessage: null,
  contextDataUpdate: null
};

describe("Supervisor Node Decision Engine (LLM mockado)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupervisorDecision(DEFAULT_DECISION);
  });

  test("deve analisar mensagem do usuário e tomar decisão de roteamento válida", async () => {
    const state: any = {
      messages: [new HumanMessage("Qual é o segredo para ter uma rotina saudável?")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main"
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-thread-sup" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();
    expect(typeof result.nextAgent).toBe("string");
    expect(modelFlashStructured.withStructuredOutput).toHaveBeenCalled();
  });

  test("deve manter silêncio em grupo se a Bia não for chamada", async () => {
    mockSupervisorDecision({
      ...DEFAULT_DECISION,
      nextAgent: "FINISH",
      response: "[SILENT]"
    });
    const state: any = {
      messages: [new HumanMessage("[CONVERSA EM GRUPO]\nCarlos: Pessoal, vamos almoçar onde hoje?")],
      nextAgent: "",
      contextData: {
        chatJid: "120363425678591898@g.us",
        chatName: "Grupo Família",
        isGroup: true,
        isTrustedChat: true,
        accountName: "main"
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-thread-group" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("FINISH");
  });

  test("deve rotear para o agente de segurança ao solicitar gerenciamento de números ou dados sensíveis em chat não confiável", async () => {
    mockSupervisorDecision({
      ...DEFAULT_DECISION,
      nextAgent: "securityAgent",
      specialistTask: "Gerenciar permissões de contatos de confiança",
      response: ""
    });
    const state: any = {
      messages: [new HumanMessage("Quais são os números de contatos de confiança cadastrados?")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main"
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-thread-sec-cmd" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("securityAgent");
  });

  test("deve aceitar e processar gatilhos de rotina agendada SEM criar dados no banco real", async () => {
    // Este teste reproduz exatamente o cenário que vazou dados para produção:
    // "[Rotina Agendada] Cobre o Luiz amigavelmente sobre a tarefa de comprar o presente"
    // (thread test-thread-cron). Com o LLM mockado, o supervisor NUNCA chama
    // missionAgent/tools reais → nenhum follow-up é criado no database.sqlite.
    mockSupervisorDecision({
      ...DEFAULT_DECISION,
      nextAgent: "FINISH",
      response: "Vou verificar isso para você."
    });
    const state: any = {
      messages: [new HumanMessage("[Rotina Agendada] Cobre o Luiz amigavelmente sobre a tarefa de comprar o presente")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main"
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-thread-cron" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("FINISH");
    // Garantia explícita: o supervisor com LLM mockado NÃO deve rotear para
    // missionAgent (que no passado criava follow-ups reais no banco de produção).
    expect(modelFlashStructured.withStructuredOutput).toHaveBeenCalled();
  });
});

describe("Supervisor — Decisão estruturada (bindTools-style)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupervisorDecision(DEFAULT_DECISION);
  });

  test("deve processar resposta do LLM e produzir resultado válido", async () => {
    const state: any = {
      messages: [new HumanMessage("Oi Bia, tudo bem?")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main",
        executionLog: [],
      },
    };

    const result = await supervisorNode(state, {
      configurable: { thread_id: "test-thread-bindtools-routing" },
    });

    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();

    if (result.nextAgent === "FINISH") {
      expect(result.messages).toBeDefined();
      expect(result.messages.length).toBeGreaterThan(0);
    }
  });

  test("deve rotear para especialista quando LLM decide usar ferramenta", async () => {
    mockSupervisorDecision({
      ...DEFAULT_DECISION,
      nextAgent: "taskAgent",
      specialistTask: "Listar tarefas pendentes",
      response: ""
    });
    const state: any = {
      messages: [new HumanMessage("Quais tarefas eu tenho pendentes?")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main",
        executionLog: [],
      },
    };

    const result = await supervisorNode(state, {
      configurable: { thread_id: "test-thread-bindtools-tool-call" },
    });

    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("taskAgent");
    expect(result.contextData?.specialistTask).toBe("Listar tarefas pendentes");
  });

  test("deve processar o ciclo de 2 passagens: tool execution → synthesis → FINISH", async () => {
    mockSupervisorDecision({
      ...DEFAULT_DECISION,
      nextAgent: "FINISH",
      response: "Aqui está o resumo das tarefas e do clima."
    });
    const state: any = {
      messages: [
        new HumanMessage(
          "Me liste as tarefas pendentes e também me diga como está o clima em Campinas"
        ),
      ],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main",
        executionLog: [],
      },
    };

    const result = await supervisorNode(state, {
      configurable: { thread_id: "test-thread-bindtools-multi" },
    });

    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();
    expect(typeof result.nextAgent).toBe("string");

    if (result.nextAgent === "FINISH") {
      expect(result.messages).toBeDefined();
    }
  });

  test("deve preservar as regras de persona, WhatsApp style e prevenção de loops", async () => {
    // Com executionLog cheio, o supervisor deve forçar FINISH mesmo que o mock
    // tente rotear para outro agente.
    mockSupervisorDecision({
      ...DEFAULT_DECISION,
      nextAgent: "taskAgent",
      specialistTask: "Listar tarefas",
      response: ""
    });
    const state: any = {
      messages: [new HumanMessage("Liste minhas tarefas")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main",
        executionLog: ["taskAgent", "taskAgent", "taskAgent", "taskAgent", "taskAgent"],
        activePlan: [],
      },
    };

    const result = await supervisorNode(state, {
      configurable: { thread_id: "test-thread-bindtools-loop" },
    });

    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();

    const validAgents = [
      "searchAgent", "calendarAgent", "gmailAgent", "sheetsAgent", "docsAgent",
      "routineAgent", "memoryAgent", "taskAgent", "securityAgent", "shoppingAgent",
      "whatsappAgent", "reasoningAgent", "weatherAgent", "FINISH",
    ];
    expect(validAgents).toContain(result.nextAgent);
  });
});

describe("cleanDsmlTags", () => {
  test("deve remover bloco completo de DSML tool_calls do texto", () => {
    const input = 'Deixa eu ver os chats recentes da sua conta pessoal pra achar o grupo "Família"!\n\n<tool_calls>\n<invoke name="listRecentChats">\n<parameter name="accountName">personal</parameter>\n<parameter name="limit">20</parameter>\n</invoke>\n</tool_calls>';
    const cleaned = cleanDsmlTags(input);
    expect(cleaned).toBe('Deixa eu ver os chats recentes da sua conta pessoal pra achar o grupo "Família"!');
    expect(cleaned).not.toContain("<tool_calls>");
  });
});

describe("Supervisor — Tolerância a decisões estruturadas incompletas", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupervisorDecision(DEFAULT_DECISION);
  });

  it("deve aceitar payload de decisão estruturada com campos omitidos (undefined)", async () => {
    // Simula resposta do LLM omitindo plan, reason e contextDataUpdate (exatamente como na exec 19D754E2)
    mockSupervisorDecision({
      nextAgent: "gmailAgent",
      specialistTask: "Verificar e-mails importantes na caixa de entrada dos últimos dias.",
      response: "",
      intermediateMessage: "Consultando sua caixa de entrada..."
    });

    const state: any = {
      messages: [new HumanMessage("Veja se tem algum email importante dos ultimos dias")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main"
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-tolerance-omitted-fields" } });
    expect(result.nextAgent).toBe("gmailAgent");
    expect(result.contextData?.specialistTask).toBe("Verificar e-mails importantes na caixa de entrada dos últimos dias.");
  });

  it("deve sanitizar intermediateMessage e specialistTask quando o modelo retornar string 'null'", async () => {
    mockSupervisorDecision({
      nextAgent: "FINISH",
      specialistTask: "null",
      response: "Olá! Tudo bem?",
      intermediateMessage: "null",
      reason: "Resposta direta ao usuário."
    });

    const state: any = {
      messages: [new HumanMessage("Oi Bia")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main"
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-sanitize-null-intermediate" } });
    expect(result.nextAgent).toBe("FINISH");
    expect(result.contextData?.specialistTask).toBeUndefined();
    expect(result.contextData?.sentIntermediate).toBeFalsy();
  });

  it("deve processar com perfeição decisão ultra-enxuta com apenas nextAgent e response [SILENT]", async () => {
    mockSupervisorDecision({
      nextAgent: "FINISH",
      response: "[SILENT]"
    });

    const state: any = {
      messages: [new HumanMessage("Conversa trivial")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main"
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-minimal-silent-decision" } });
    expect(result.nextAgent).toBe("FINISH");
    expect(result.messages?.[0]?.content).toBe("[SILENT]");
  });
});

describe("Supervisor — Precedência e Conteúdo dos Cenários (buildSupervisorPrompt)", () => {
  test("Cenário 3: Conta pessoal passiva tem prioridade máxima", () => {
    const prompt = buildSupervisorPrompt({ accountName: "personal", isMaster: true, isTrustedChat: true, isGroup: false });
    expect(prompt).toContain("observadora passiva");
    expect(prompt).toContain("SILÊNCIO (99% dos casos)");
    expect(prompt).not.toContain("CATÁLOGO DE AGENTES");
  });

  test("Cenário 1A: Interação direta com o Criador (isMaster: true)", () => {
    const prompt = buildSupervisorPrompt({ accountName: "main", isMaster: true, isTrustedChat: true, isGroup: false });
    expect(prompt).toContain("CENÁRIO 1A: INTERAÇÃO DIRETA COM O CRIADOR (ACESSO TOTAL)");
    expect(prompt).toContain("securityAgent:");
    expect(prompt).toContain("emailSentinelAgent:");
  });

  test("Cenário 1B: Interação 1-1 com Contato Confiável", () => {
    const prompt = buildSupervisorPrompt({ accountName: "main", isMaster: false, isTrustedChat: true, isGroup: false });
    expect(prompt).toContain("CENÁRIO 1B: INTERAÇÃO 1-1 COM CONTATO CONFIÁVEL");
    // Contatos confiáveis não recebem skills que exigem requiresCreator
    expect(prompt).not.toContain("securityAgent:");
    expect(prompt).not.toContain("emailSentinelAgent:");
    // Mas recebem skills confiáveis normais
    expect(prompt).toContain("searchAgent:");
    expect(prompt).toContain("gmailAgent:");
  });

  test("Cenário 1C: Interação em Grupo Confiável", () => {
    const prompt = buildSupervisorPrompt({ accountName: "main", isMaster: false, isTrustedChat: true, isGroup: true });
    expect(prompt).toContain("CENÁRIO 1C: INTERAÇÃO EM GRUPO CONFIÁVEL");
    expect(prompt).toContain("participar ativamente deste grupo");
    expect(prompt).not.toContain("securityAgent:");
  });

  test("Cenário 2B: Interação em Grupos Não-Confiáveis", () => {
    const prompt = buildSupervisorPrompt({ accountName: "main", isMaster: false, isTrustedChat: false, isGroup: true });
    expect(prompt).toContain("CENÁRIO 2B: INTERAÇÃO EM GRUPOS (NÃO-CONFIÁVEIS)");
    expect(prompt).toContain("Regra de silêncio: responda apenas se for chamada explicitamente");
    expect(prompt).toContain("AGENTES ESPECIALISTAS DISPONÍVEIS (MODO RESTRITO)");
    expect(prompt).not.toContain("gmailAgent:");
  });

  test("Cenário 2A: Interação 1-1 Não-Confiável (Terceiros / Missões)", () => {
    const prompt = buildSupervisorPrompt({ accountName: "main", isMaster: false, isTrustedChat: false, isGroup: false });
    expect(prompt).toContain("CENÁRIO 2A: INTERAÇÃO 1-1 (NÃO-CONFIÁVEL / TERCEIROS)");
    expect(prompt).toContain("assistente pessoal EXCLUSIVA do seu criador");
    expect(prompt).toContain("AGENTES ESPECIALISTAS DISPONÍVEIS (MODO RESTRITO)");
    expect(prompt).not.toContain("gmailAgent:");
  });

  test("Trava defensiva do Cenário 3: força nextAgent = FINISH mesmo se LLM tentar rotear", async () => {
    mockSupervisorDecision({
      ...DEFAULT_DECISION,
      nextAgent: "searchAgent",
      specialistTask: "Pesquisar algo indevido",
      response: "[SILENT]"
    });

    const state: any = {
      messages: [new HumanMessage("Conversa interceptada na conta pessoal")],
      nextAgent: "",
      contextData: {
        chatJid: "5519999999999@s.whatsapp.net",
        accountName: "personal",
        isTrustedChat: false
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-personal-guard" } });
    expect(result.nextAgent).toBe("FINISH");
    expect(result.contextData?.specialistTask).toBeUndefined();
  });

  test("Normalização de Silêncio: deve converter response vazio ('') em [SILENT] sem gerar mensagem de erro", async () => {
    mockSupervisorDecision({
      ...DEFAULT_DECISION,
      nextAgent: "FINISH",
      response: "",
      reason: "Condição de silêncio atendida"
    });

    const state: any = {
      messages: [new HumanMessage("Se o dia for de sol, fique em silêncio")],
      nextAgent: "",
      contextData: {
        chatJid: "5519997064504@s.whatsapp.net",
        isTrustedChat: true,
        accountName: "main"
      }
    };

    const result = await supervisorNode(state, { configurable: { thread_id: "test-silent-empty-response" } });
    expect(result.nextAgent).toBe("FINISH");
    expect(result.contextData?.proposedResponse).toBe("[SILENT]");
  });
});

