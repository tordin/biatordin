import { 
  initSecurityTable,
  createApprovalToken, 
  consumeApprovalToken, 
  isTrustedChat,
  addTrustedChat,
  removeTrustedChat,
  listTrustedChats,
  MASTER_JIDS
} from "../../src/memory/security.js";

describe("Security Memory & Approval Tokens", () => {
  const testJid = "551988887777@s.whatsapp.net";

  beforeAll(async () => {
    await initSecurityTable();
  });

  test("deve considerar os JIDs Master como confiáveis por padrão", async () => {
    for (const masterJid of MASTER_JIDS) {
      const trusted = await isTrustedChat(masterJid);
      expect(trusted).toBe(true);
    }
  });

  test("deve criar e consumir token de aprovação de chat de confiança", () => {
    const token = createApprovalToken(testJid);
    expect(token).toBeDefined();
    expect(token.length).toBe(4);

    const consumedJid = consumeApprovalToken(token);
    expect(consumedJid).toBe(testJid);

    // Segunda tentativa deve retornar null
    const secondTry = consumeApprovalToken(token);
    expect(secondTry).toBeNull();
  });



  test("deve adicionar, verificar, listar e remover chats de confiança", async () => {
    // Adicionar
    await addTrustedChat(testJid);
    let trusted = await isTrustedChat(testJid);
    expect(trusted).toBe(true);

    // Listar
    const list = await listTrustedChats();
    expect(list.some((item: any) => item.jid === testJid)).toBe(true);

    // Remover
    await removeTrustedChat(testJid);
    trusted = await isTrustedChat(testJid);
    expect(trusted).toBe(false);
  });

});
