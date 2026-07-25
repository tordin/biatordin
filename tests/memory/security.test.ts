import { 
  initSecurityTable,
  createApprovalToken, 
  consumeApprovalToken, 
  createMessageApprovalToken, 
  consumeMessageApprovalToken,
  isTrustedChat,
  addTrustedChat,
  removeTrustedChat,
  listTrustedChats,
  isAutoReplyChat,
  addAutoReplyChat,
  removeAutoReplyChat,
  listAutoReplyChats,
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

  test("deve criar e consumir token de aprovação de envio de mensagem", () => {
    const msgText = "Olá, tudo bem?";
    const token = createMessageApprovalToken(testJid, msgText);
    expect(token).toBeDefined();
    expect(token.length).toBe(4);

    const pending = consumeMessageApprovalToken(token);
    expect(pending).not.toBeNull();
    expect(pending?.targetJid).toBe(testJid);
    expect(pending?.message).toBe(msgText);

    // Consumo repetido deve retornar null
    expect(consumeMessageApprovalToken(token)).toBeNull();
  });

  test("deve adicionar, verificar, listar e remover chats de confiança", async () => {
    // Adicionar
    await addTrustedChat(testJid);
    let trusted = await isTrustedChat(testJid);
    expect(trusted).toBe(true);

    // Listar
    const list = await listTrustedChats();
    expect(list.some(item => item.jid === testJid)).toBe(true);

    // Remover
    await removeTrustedChat(testJid);
    trusted = await isTrustedChat(testJid);
    expect(trusted).toBe(false);
  });

  test("deve adicionar, verificar, listar e remover chats de auto-resposta", async () => {
    const autoReplyJid = "551977776666@s.whatsapp.net";

    await addAutoReplyChat(autoReplyJid);
    let enabled = await isAutoReplyChat(autoReplyJid);
    expect(enabled).toBe(true);

    const list = await listAutoReplyChats();
    expect(list.some(item => item.jid === autoReplyJid)).toBe(true);

    await removeAutoReplyChat(autoReplyJid);
    enabled = await isAutoReplyChat(autoReplyJid);
    expect(enabled).toBe(false);
  });
});
