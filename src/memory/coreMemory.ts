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
 * Trusted chats get global memory + strictly their own chat's sandbox (if any).
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
    
    // Include ONLY this specific chat's sandbox if it exists
    if (chatJid && chatJid !== 'unknown') {
      const safeJid = chatJid.replace(/[^a-zA-Z0-9_-]/g, '_');
      const chatMemFile = path.join(SANDBOX_DIR, safeJid, 'bia_memory.md');
      if (fs.existsSync(chatMemFile)) {
        const sandboxContent = fs.readFileSync(chatMemFile, 'utf-8').trim();
        const isDefault = sandboxContent === `# Memória e Arquivos Isolados (${chatJid})\n\nNenhuma anotação por enquanto.`;
        if (sandboxContent && !isDefault) {
          globalMemory += `\n\n--- ANOTAÇÕES DESTE CHAT (${chatJid}) ---\n${sandboxContent}`;
        }
      }
    }

    return globalMemory;
  } catch (error) {
    logger.error('Failed to read memory file:', error);
    return 'Erro ao ler a memória.';
  }
}

/**
 * Helper to retrieve all sandboxes if explicitly requested by memory management tasks.
 */
export function getAllSandboxesMemory(): string {
  let sandboxesContext = "\n\n--- TODOS OS SANDBOXES ---\n";
  if (fs.existsSync(SANDBOX_DIR)) {
    const dirs = fs.readdirSync(SANDBOX_DIR);
    for (const dir of dirs) {
      const memFile = path.join(SANDBOX_DIR, dir, 'bia_memory.md');
      if (fs.existsSync(memFile)) {
        const content = fs.readFileSync(memFile, 'utf-8');
        sandboxesContext += `\n[SANDBOX DO CHAT: ${dir}]\n${content}\n-----------------------------------\n`;
      }
    }
  }
  return sandboxesContext;
}

import { syncCoreMemoryToVector, addVectorMemory } from './vectorMemory.js';

if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    syncCoreMemoryToVector().catch(err => {
      logger.error('[MEMORY] Erro na sincronização inicial com vetor:', err);
    });
  }, 1000);
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

    // Sincroniza em segundo plano no banco vetorial RAG
    syncCoreMemoryToVector().catch(err => {
      logger.error('[MEMORY] Falha ao sincronizar atualização da memória para o vetor RAG:', err);
    });
  } catch (error) {
    logger.error('Failed to update memory file:', error);
    throw new Error('Não foi possível salvar a memória.');
  }
}

/**
 * Deletes a specific string/content from Bia's memory.
 * Trusted chats remove from the global memory. Untrusted chats remove from their sandbox.
 */
export function deleteFromMemory(chatJid: string, isTrustedChat: boolean, textToRemove: string): boolean {
  try {
    const targetFile = (!isTrustedChat && chatJid) ? getSandboxFile(chatJid) : MEMORY_FILE;
    
    let currentContent = fs.readFileSync(targetFile, 'utf-8');
    
    if (currentContent.includes(textToRemove)) {
      // Remove o texto exato
      const newContent = currentContent.replace(textToRemove, '').replace(/\n{3,}/g, '\n\n');
      fs.writeFileSync(targetFile, newContent, 'utf-8');
      
      logger.info(`[MEMORY] Texto removido com sucesso de ${targetFile}`);
      
      // Sincroniza em segundo plano no banco vetorial RAG (apenas para core)
      if (isTrustedChat || targetFile === MEMORY_FILE) {
        syncCoreMemoryToVector().catch(err => {
          logger.error('[MEMORY] Falha ao sincronizar exclusão da memória para o vetor RAG:', err);
        });
      }
      return true;
    }
    
    logger.warn(`[MEMORY] Texto não encontrado para exclusão em ${targetFile}`);
    return false;
  } catch (error) {
    logger.error('Failed to delete from memory file:', error);
    return false;
  }
}

