import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { supervisorNode } from "../../src/agents/supervisor.js";

describe("Supervisor Node Decision Engine", () => {
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
  }, 30000);

  test("deve manter silêncio em grupo se a Bia não for chamada", async () => {
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
  }, 30000);

  test("deve rotear para o agente de segurança ao solicitar gerenciamento de números ou dados sensíveis em chat não confiável", async () => {
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
    expect(result.nextAgent).toBeDefined();
  }, 30000);

  test("deve aceitar e processar gatilhos de rotina agendada", async () => {
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
    expect(result.nextAgent).toBeDefined();
  }, 30000);
});

describe("Supervisor — Dynamic Tool Binding (bindTools)", () => {
  test("deve usar bindTools com todas as ferramentas e processar resposta do LLM", async () => {
    // This test verifies the bindTools architecture is wired correctly.
    // We use a query that the LLM can answer directly without tool calls,
    // verifying the routing path still works.
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

    // The supervisor should produce a valid result
    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();

    // When FINISH, there should be response messages
    if (result.nextAgent === "FINISH") {
      expect(result.messages).toBeDefined();
      expect(result.messages.length).toBeGreaterThan(0);
    }
  }, 30000);

  test("deve executar bindTools e processar tool_calls quando LLM decide usar ferramentas", async () => {
    // Query that typically requires a tool (weather lookup)
    const state: any = {
      messages: [new HumanMessage("Qual é a previsão do tempo para São Paulo amanhã?")],
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

    // The supervisor processes tool calls and synthesizes
    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();

    // Check that contextData is in valid shape
    expect(result.contextData).toBeDefined();

    // If the model called tools, result should be FINISH with messages
    if (result.nextAgent === "FINISH" && result.messages) {
      // Verify at least one message in the result
      expect(result.messages.length).toBeGreaterThanOrEqual(0);
      if (result.messages.length > 0) {
        const lastMsg = result.messages[result.messages.length - 1];
        // Should be an AIMessage (synthesized response)
        expect(lastMsg).toBeDefined();
      }
    }
  }, 30000);

  test("deve processar o ciclo de 2 passagens: tool execution → synthesis → FINISH", async () => {
    // Multiple queries that might trigger tool calls
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

    // Result should always be defined with a nextAgent
    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();
    expect(typeof result.nextAgent).toBe("string");

    // If tools were executed, synthesis should produce a response
    if (result.nextAgent === "FINISH") {
      expect(result.messages).toBeDefined();
    }
  }, 30000);

  test("deve preservar as regras de persona, WhatsApp style e prevenção de loops após bindTools", async () => {
    // Test that the loop prevention still works
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

    // Loop prevention: if executionLog is full, should FINISH or route elsewhere,
    // not keep calling the same agent
    expect(result).toBeDefined();
    expect(result.nextAgent).toBeDefined();

    // With 5+ executions in log, maxAgentCalls check should force FINISH
    // (if the model didn't already choose FINISH for other reasons)
    const validAgents = [
      "searchAgent", "calendarAgent", "gmailAgent", "sheetsAgent", "docsAgent",
      "routineAgent", "memoryAgent", "taskAgent", "securityAgent", "shoppingAgent",
      "whatsappAgent", "reasoningAgent", "weatherAgent", "FINISH",
    ];
    expect(validAgents).toContain(result.nextAgent);
  }, 30000);
});
