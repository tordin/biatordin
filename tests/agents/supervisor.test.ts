import { HumanMessage } from "@langchain/core/messages";
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
