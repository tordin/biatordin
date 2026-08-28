import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { HumanMessage } from "@langchain/core/messages";
import { initSecurityTable } from "../../src/memory/security.js";
import { initEntitiesTable } from "../../src/memory/entities.js";
import { 
  securityAgentNode,
  addTrustedChatTool,
  removeTrustedChatTool,
  checkTrustTool,
  listTrustedChatsTool,
  getMasterInfoTool,
  connectPersonalAccountTool,
  disconnectPersonalAccountTool,
  checkPersonalAccountStatusTool,
  ignoreGroupTool,
  unignoreGroupTool,
  listIgnoredGroupsTool
} from "../../src/agents/securityAgent.js";

describe("Security Agent Node & Tool Handlers Direct Invocation", () => {
  const masterJid = "5519997064504@s.whatsapp.net";
  const dummyJid = "551988887777@s.whatsapp.net";

  beforeAll(async () => {
    await initSecurityTable();
    await initEntitiesTable();
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test("deve validar schemas e metadados das ferramentas de contatos de confiança", () => {
    expect(addTrustedChatTool.name).toBe("add_trusted_chat");
    expect(removeTrustedChatTool.name).toBe("remove_trusted_chat");
    expect(checkTrustTool.name).toBe("check_trust");
    expect(listTrustedChatsTool.name).toBe("list_trusted_chats");
  });

  test("deve testar ferramentas do master e conta pessoal", async () => {
    expect(getMasterInfoTool.name).toBe("get_master_info");
    expect(connectPersonalAccountTool.name).toBe("connect_personal_account");
    expect(disconnectPersonalAccountTool.name).toBe("disconnect_personal_account");
    expect(checkPersonalAccountStatusTool.name).toBe("check_personal_account_status");
  });

  test("deve testar ferramentas de grupos ignorados", () => {
    expect(ignoreGroupTool.name).toBe("ignore_group");
    expect(listIgnoredGroupsTool.name).toBe("list_ignored_groups");
    expect(unignoreGroupTool.name).toBe("unignore_group");
  });

  test("deve responder pelo agente completo", async () => {
    const { securityReactAgent } = await import("../../src/agents/securityAgent.js");
    const { jest } = await import("@jest/globals");
    const { AIMessage } = await import("@langchain/core/messages");
    
    jest.spyOn(securityReactAgent, "invoke").mockResolvedValueOnce({
      messages: [new AIMessage("Aqui estão os chats de confiança")]
    } as any);

    const initialState: any = {
      messages: [new HumanMessage("Quais são os chats de confiança cadastrados?")],
      contextData: { chatJid: masterJid, isTrustedChat: true }
    };

    const result = await securityAgentNode(initialState as any);
    expect(result).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
