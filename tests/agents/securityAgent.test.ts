import { HumanMessage } from "@langchain/core/messages";
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

  test("deve testar a execução direta de ferramentas de contatos de confiança", async () => {
    // Add trusted chat
    const addRes = await addTrustedChatTool.invoke({ jid: dummyJid });
    expect(addRes).toContain("adicionado à lista");

    // Check trust
    const checkRes = await checkTrustTool.invoke({ jid: dummyJid });
    expect(checkRes).toContain("É de confiança");

    // List trusted
    const listRes = await listTrustedChatsTool.invoke({});
    expect(listRes).toContain("Chats de confiança atuais");

    // Remove trusted
    const removeRes = await removeTrustedChatTool.invoke({ jid: dummyJid });
    expect(removeRes).toContain("removido da lista");
  });

  test("deve testar ferramentas do master e conta pessoal", async () => {
    const masterInfo = await getMasterInfoTool.invoke({});
    expect(masterInfo).toContain("Master");

    const connectRes = await connectPersonalAccountTool.invoke({});
    expect(connectRes).toBeDefined();

    const statusRes = await checkPersonalAccountStatusTool.invoke({});
    expect(statusRes).toBeDefined();

    const disconnectRes = await disconnectPersonalAccountTool.invoke({});
    expect(disconnectRes).toBeDefined();
  });

  test("deve testar ferramentas de grupos ignorados", async () => {
    const config = { configurable: { contextData: { chatJid: "120363000000000000@g.us" } } } as any;

    const ignoreRes = await ignoreGroupTool.invoke({ target: "atual" }, config);
    expect(ignoreRes).toContain("lista de grupos ignorados");

    const listIgnored = await listIgnoredGroupsTool.invoke({});
    expect(listIgnored).toContain("Grupos ignorados");

    const unignoreRes = await unignoreGroupTool.invoke({ target: "120363000000000000@g.us" }, config);
    expect(unignoreRes).toContain("removido da lista");
  });

  test("deve responder pelo agente completo", async () => {
    const { modelFlash } = await import("../../src/llm/model.js");
    const { jest } = await import("@jest/globals");
    jest.spyOn(modelFlash, "invoke").mockResolvedValueOnce(new HumanMessage("Aqui estão os chats de confiança") as any);

    const initialState: any = {
      messages: [new HumanMessage("Quais são os chats de confiança cadastrados?")],
      contextData: { chatJid: masterJid, isTrustedChat: true }
    };

    const result = await securityAgentNode(initialState as any);
    expect(result).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);
});
