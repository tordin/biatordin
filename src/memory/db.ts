import sqlite3 from 'sqlite3';
import path from 'path';
import { logger } from '../utils/logger.js';

let dbInstance: sqlite3.Database | null = null;
let currentDbPath: string | null = null;

/**
 * Retorna o caminho absoluto do banco de dados SQLite ativo.
 * Prioriza a variável de ambiente SQLITE_DB_PATH (usada em testes),
 * com fallback para o banco principal 'database.sqlite'.
 */
export function getDbPath(): string {
  if (process.env.SQLITE_DB_PATH) {
    return path.isAbsolute(process.env.SQLITE_DB_PATH)
      ? process.env.SQLITE_DB_PATH
      : path.resolve(process.cwd(), process.env.SQLITE_DB_PATH);
  }
  return path.resolve(process.cwd(), 'database.sqlite');
}

/**
 * Retorna a instância única (singleton) da conexão SQLite.
 * Configura automaticamente PRAGMA journal_mode = WAL e PRAGMA busy_timeout = 5000.
 */
export function getDb(): sqlite3.Database {
  const activePath = getDbPath();

  // Se o caminho do banco mudou (ex: chaveamento em testes), fecha a instância anterior
  if (dbInstance && currentDbPath !== activePath) {
    try {
      dbInstance.close();
    } catch {
      // Ignora erro ao fechar conexão antiga durante troca
    }
    dbInstance = null;
  }

  if (!dbInstance) {
    currentDbPath = activePath;
    dbInstance = new sqlite3.Database(activePath, (err) => {
      if (err) {
        logger.error(`[DB] Erro ao conectar no SQLite (${activePath}):`, err);
      }
    });

    dbInstance.serialize(() => {
      dbInstance?.run("PRAGMA journal_mode = WAL;");
      dbInstance?.run("PRAGMA busy_timeout = 5000;");
    });
  }

  return dbInstance;
}

/**
 * Fecha a conexão ativa do SQLite de forma graciosa.
 */
export function closeDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      dbInstance.close((err) => {
        if (err) {
          logger.error('[DB] Erro ao fechar conexão SQLite:', err);
          return reject(err);
        }
        dbInstance = null;
        currentDbPath = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
