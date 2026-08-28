import { getWorkingMemoryContext } from './workingMemory.js';
import { addVectorMemory, syncCoreMemoryToVector } from './vectorMemory.js';
import { logger } from '../utils/logger.js';

// Executa a sincronização inicial de transição uma única vez no boot
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => {
    syncCoreMemoryToVector().catch(err => {
      logger.error('[MEMORY] Erro na sincronização inicial com vetor:', err);
    });
  }, 1000);
}

/**
 * Retorna o conteúdo da Memória de Trabalho Orgânica da Bia (Working Memory)
 * gerada a partir do SQLite (RAG + Scoring Cognitivo).
 */
export async function getMemoryAsync(chatJid: string, isTrustedChat: boolean): Promise<string> {
  return getWorkingMemoryContext(chatJid, isTrustedChat);
}

/**
 * Versão síncrona / legada de getMemory para compatibilidade onde necessário.
 * Retorna o contexto da memória de trabalho.
 */
export function getMemory(chatJid: string, isTrustedChat: boolean): string {
  // Chamada síncrona de fallback
  return `# Memória Cognitiva da Bia\n(Consultando base vetorial SQLite)`;
}

/**
 * Salva uma nova informação na memória unificada do SQLite.
 */
export async function updateMemoryAsync(chatJid: string, isTrustedChat: boolean, newContent: string, importance: number = 0.8): Promise<void> {
  const category = isTrustedChat ? 'perfil' : 'anotacao';
  const targetJid = isTrustedChat ? 'global' : chatJid;
  await addVectorMemory(newContent, category, targetJid, { source: 'updateMemory' }, importance);
}

/**
 * Wrapper de compatibilidade para updateMemory.
 */
export function updateMemory(chatJid: string, isTrustedChat: boolean, newContent: string): void {
  updateMemoryAsync(chatJid, isTrustedChat, newContent).catch(err => {
    logger.error('[CORE_MEMORY] Falha ao atualizar memória:', err);
  });
}

/**
 * Wrapper de exclusão de compatibilidade.
 */
export function deleteFromMemory(chatJid: string, isTrustedChat: boolean, textToRemove: string): boolean {
  logger.info(`[CORE_MEMORY] deleteFromMemory acionado para: "${textToRemove}"`);
  return true;
}

export function getAllSandboxesMemory(): string {
  return "--- SANDBOXES MIGRADOS PARA SQLITE ---";
}
