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
  });
});
