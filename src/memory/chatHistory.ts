import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

const HISTORY_DIR = path.join(process.cwd(), 'data', 'history');

export interface ChatMessage {
  id: string;
  timestamp: number;
  date?: string;
  sender: string;
  senderName: string;
  chatName?: string;
  content: string;
  isFromMe: boolean;
}

export function appendMessageToHistory(accountName: string, chatJid: string, message: ChatMessage) {
  const accountDir = path.join(HISTORY_DIR, accountName);
  if (!fs.existsSync(accountDir)) {
    fs.mkdirSync(accountDir, { recursive: true });
  }

  const filePath = path.join(accountDir, `${chatJid}.json`);
  let history: ChatMessage[] = [];

  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      history = JSON.parse(data);
    } catch (e) {
      logger.error(`[CHAT HISTORY] Falha ao ler histórico de ${chatJid}:`, e);
    }
  }

  // Previne duplicação de IDs (embora não seja 100% perfeito se o ID for vazio, mas cobrimos o básico)
  if (message.id && history.find(m => m.id === message.id)) {
    return;
  }

  if (!message.date) {
    message.date = new Date(message.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }

  history.push(message);
  
  // Limita a 1000 mensagens por arquivo para não explodir em tamanho
  if (history.length > 1000) {
    history = history.slice(history.length - 1000);
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
  } catch (e) {
    logger.error(`[CHAT HISTORY] Falha ao escrever histórico de ${chatJid}:`, e);
  }
}

export function getChatHistory(accountName: string, chatJid: string, limit: number = 50): ChatMessage[] {
  const filePath = path.join(HISTORY_DIR, accountName, `${chatJid}.json`);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const history: ChatMessage[] = JSON.parse(data);
    return history.slice(-limit);
  } catch (e) {
    logger.error(`[CHAT HISTORY] Falha ao ler histórico de ${chatJid}:`, e);
    return [];
  }
}

export function listRecentChats(accountName: string, limit: number = 10): { chatJid: string, name?: string, lastMessageAt: number }[] {
  const accountDir = path.join(HISTORY_DIR, accountName);
  if (!fs.existsSync(accountDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(accountDir).filter(f => f.endsWith('.json'));
    const chats = files.map(file => {
      const filePath = path.join(accountDir, file);
      const stat = fs.statSync(filePath);
      
      let name = "Desconhecido";
      try {
        const data = fs.readFileSync(filePath, 'utf-8');
        const history: ChatMessage[] = JSON.parse(data);
        if (history.length > 0) {
           const lastTheirs = history.slice().reverse().find(m => !m.isFromMe);
           if (lastTheirs && lastTheirs.senderName) {
             name = lastTheirs.senderName;
           } else if (history[0].senderName) {
             name = history[0].senderName;
           }
        }
      } catch(e) {}

      return {
        chatJid: file.replace('.json', ''),
        name,
        lastMessageAt: stat.mtimeMs
      };
    });

    // Ordena por data de modificação (mais recente primeiro)
    chats.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    
    return chats.slice(0, limit);
  } catch (e) {
    logger.error(`[CHAT HISTORY] Falha ao listar chats recentes de ${accountName}:`, e);
    return [];
  }
}

export function searchChatByName(accountName: string, queryName: string): { chatJid: string, name: string }[] {
  const accountDir = path.join(HISTORY_DIR, accountName);
  if (!fs.existsSync(accountDir)) return [];

  const results: { chatJid: string, name: string }[] = [];
  try {
    const files = fs.readdirSync(accountDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(accountDir, file);
      try {
        const data = fs.readFileSync(filePath, 'utf-8');
        const history: ChatMessage[] = JSON.parse(data);
        if (history.length > 0) {
          const lastTheirs = history.slice().reverse().find(m => !m.isFromMe);
          let name = lastTheirs?.chatName || history[0].chatName || lastTheirs?.senderName || history[0].senderName || "";
          
          if (name.toLowerCase().includes(queryName.toLowerCase())) {
            results.push({ chatJid: file.replace('.json', ''), name });
          }
        }
      } catch(e) {}
    }
  } catch(e) {}
  return results;
}
