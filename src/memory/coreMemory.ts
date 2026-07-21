import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'bia_memory.md');
const SANDBOX_DIR = path.join(DATA_DIR, 'sandboxes');

// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(SANDBOX_DIR)) {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}

// Ensure the global file exists
if (!fs.existsSync(MEMORY_FILE)) {
  fs.writeFileSync(MEMORY_FILE, '# Memória Global da Bia\n\nNenhuma anotação por enquanto.\n', 'utf-8');
}

function getSandboxFile(chatJid: string): string {
  // Safe filename
  const safeJid = chatJid.replace(/[^a-zA-Z0-9_-]/g, '_');
  const chatSandboxDir = path.join(SANDBOX_DIR, safeJid);
  if (!fs.existsSync(chatSandboxDir)) {
    fs.mkdirSync(chatSandboxDir, { recursive: true });
  }
  const memoryFile = path.join(chatSandboxDir, 'bia_memory.md');
  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(memoryFile, `# Memória e Arquivos Isolados (${chatJid})\n\nNenhuma anotação por enquanto.\n`, 'utf-8');
  }
  return memoryFile;
}

/**
 * Retrieves the current contents of Bia's memory.
 * Trusted chats get the global memory + a read-only view of all sandboxes.
 * Untrusted chats get ONLY their sandbox memory.
 */
export function getMemory(chatJid: string, isTrustedChat: boolean): string {
  try {
    if (!isTrustedChat && chatJid) {
      const sandboxFile = getSandboxFile(chatJid);
      return fs.readFileSync(sandboxFile, 'utf-8');
    }

    // For trusted chats, read global memory
    let globalMemory = fs.readFileSync(MEMORY_FILE, 'utf-8');
    
    // Append sandboxes as read-only context
    let sandboxesContext = "\n\n--- INÍCIO DOS SANDBOXES (SOMENTE LEITURA) ---\n";
    let hasSandboxes = false;
    
    if (fs.existsSync(SANDBOX_DIR)) {
      const dirs = fs.readdirSync(SANDBOX_DIR);
      for (const dir of dirs) {
        const memFile = path.join(SANDBOX_DIR, dir, 'bia_memory.md');
        if (fs.existsSync(memFile)) {
          hasSandboxes = true;
          const content = fs.readFileSync(memFile, 'utf-8');
          sandboxesContext += `\n[SANDBOX DO CHAT: ${dir}]\n${content}\n-----------------------------------\n`;
        }
      }
    }
    
    if (!hasSandboxes) {
      sandboxesContext += "Nenhum sandbox criado ainda.\n-----------------------------------\n";
    }

    return globalMemory + sandboxesContext;
  } catch (error) {
    logger.error('Failed to read memory file:', error);
    return 'Erro ao ler a memória.';
  }
}

/**
 * Updates Bia's memory with new content.
 * Trusted chats update the global memory. Untrusted chats update their sandbox.
 */
export function updateMemory(chatJid: string, isTrustedChat: boolean, newContent: string): void {
  try {
    if (!isTrustedChat && chatJid) {
      const sandboxFile = getSandboxFile(chatJid);
      fs.writeFileSync(sandboxFile, newContent, 'utf-8');
      logger.info(`[MEMORY] Sandbox memory for ${chatJid} updated successfully.`);
    } else {
      fs.writeFileSync(MEMORY_FILE, newContent, 'utf-8');
      logger.info('[MEMORY] Global memory updated successfully.');
    }
  } catch (error) {
    logger.error('Failed to update memory file:', error);
    throw new Error('Não foi possível salvar a memória.');
  }
}
