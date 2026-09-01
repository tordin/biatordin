import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { whatsappAgentNode, whatsappAgent, generateDailySummaryTool } from "../../src/agents/whatsappAgent.js";
import { initializeDailySummaryDB } from "../../src/memory/dailySummary.js";

describe("WhatsApp Specialist Agent Node", () => {
  beforeAll(async () => {
    await initializeDailySummaryDB();
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test("deve responder a consultas de mensagens recentes do WhatsApp", async () => {
    const initialState: any = {
      messages: [new HumanMessage("Tem alguma mensagem recente pra mim?")],
      contextData: { 
        chatJid: "5519997064504@s.whatsapp.net", 
        isTrustedChat: true,
        accountName: "main" 
      }
    };

    jest.spyOn(whatsappAgent, "invoke").mockImplementation(async (input: any) => ({
      messages: [...input.messages, new AIMessage("Você tem 2 mensagens recentes.")]
    } as any));

    const result = await whatsappAgentNode(initialState, { configurable: { thread_id: "test-thread-wa" } });
    expect(result).toBeDefined();
    expect(result.nextAgent).toBe("supervisor");
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test("generateDailySummaryTool deve ter schema e metadados válidos", () => {
    expect(generateDailySummaryTool.name).toBe("generate_daily_summary");
    expect(generateDailySummaryTool.description).toContain("resumo diário");
    expect(generateDailySummaryTool.description).toContain("72h");
  });

  test("searchGroupsTool deve ter descrição explicativa de case-insensitive", async () => {
    const { searchGroupsTool } = await import("../../src/agents/whatsappAgent.js");
    expect(searchGroupsTool.name).toBe("searchGroups");
    expect(searchGroupsTool.description).toContain("CASE-INSENSITIVE");
  });

  test("formatJidForUser deve resolver nome de grupo via fallback do histórico local", async () => {
    const { formatJidForUser } = await import("../../src/utils/jidResolver.js");
    const { appendMessageToHistory } = await import("../../src/memory/chatHistory.js");

    const testGroupJid = "120363999999999999@g.us";
    appendMessageToHistory("personal", testGroupJid, {
      id: "msg-test-1",
      timestamp: Date.now(),
      sender: "551999999999@s.whatsapp.net",
      senderName: "João",
      chatName: "Grupo Teste Fallback",
      content: "Olá mundo",
      isFromMe: false
    });

    const resolvedName = await formatJidForUser(testGroupJid);
    expect(resolvedName).toBe("Grupo Teste Fallback");
  });
});
