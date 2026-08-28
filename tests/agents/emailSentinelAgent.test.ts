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

  test("emailSentinelAgentNode deve estar definido e ser função", () => {
    expect(typeof emailSentinelAgentNode).toBe("function");
  });
});
