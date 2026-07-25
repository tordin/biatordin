import fs from 'fs';
import path from 'path';
import { 
  appendMessageToHistory, 
  getChatHistory, 
  listRecentChats, 
  searchChatByName,
  ChatMessage
} from '../../src/memory/chatHistory.js';

describe('Chat History File-Based System', () => {
  const testAccount = 'test_account_unit';
  const testJid = '551999990000@s.whatsapp.net';
  const historyDir = path.join(process.cwd(), 'data', 'history', testAccount);

  afterAll(() => {
    // Limpeza de arquivos de teste
    if (fs.existsSync(historyDir)) {
      fs.rmSync(historyDir, { recursive: true, force: true });
    }
  });

  test('deve adicionar mensagem ao histórico e recuperar corretamente', () => {
    const msg: ChatMessage = {
      id: 'msg-1',
      timestamp: Date.now(),
      sender: testJid,
      senderName: 'Carlos Teste',
      content: 'Mensagem de teste unitário',
      isFromMe: false
    };

    appendMessageToHistory(testAccount, testJid, msg);

    const history = getChatHistory(testAccount, testJid, 10);
    expect(history.length).toBe(1);
    expect(history[0].id).toBe('msg-1');
    expect(history[0].content).toBe('Mensagem de teste unitário');
  });

  test('não deve duplicar mensagem com o mesmo ID', () => {
    const msg: ChatMessage = {
      id: 'msg-1',
      timestamp: Date.now(),
      sender: testJid,
      senderName: 'Carlos Teste',
      content: 'Mensagem duplicada',
      isFromMe: false
    };

    appendMessageToHistory(testAccount, testJid, msg);

    const history = getChatHistory(testAccount, testJid, 10);
    expect(history.length).toBe(1);
  });

  test('deve listar chats recentes ordenados por última mensagem', () => {
    const chat2Jid = '551999991111@s.whatsapp.net';
    appendMessageToHistory(testAccount, chat2Jid, {
      id: 'msg-2',
      timestamp: Date.now() + 1000,
      sender: chat2Jid,
      senderName: 'Mariana Teste',
      content: 'Outra mensagem recente',
      isFromMe: false
    });

    const recent = listRecentChats(testAccount, 10);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent[0].chatJid).toBe(chat2Jid);
    expect(recent[0].name).toBe('Mariana Teste');
  });

  test('deve pesquisar chat pelo nome', () => {
    const results = searchChatByName(testAccount, 'Mariana');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Mariana Teste');
  });
});
