import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';

const db = new sqlite3.Database('database.sqlite', (err) => {
  if (err) {
    logger.error("[PENDING_QUEUE DB] Erro ao conectar no SQLite:", err);
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS pending_messages (
      id TEXT PRIMARY KEY,
      queueKey TEXT NOT NULL,
      accountName TEXT NOT NULL,
      chatJid TEXT NOT NULL,
      text TEXT NOT NULL,
      displayName TEXT NOT NULL,
      userJid TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      metadata TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

export interface PersistedBufferedMessage {
  id: string;
  queueKey: string;
  accountName: string;
  chatJid: string;
  text: string;
  displayName: string;
  userJid: string;
  timestamp: number;
  metadata: string;
}

export function savePendingMessage(
  id: string,
  queueKey: string,
  accountName: string,
  chatJid: string,
  text: string,
  displayName: string,
  userJid: string,
  timestamp: number,
  metadata: any
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO pending_messages (id, queueKey, accountName, chatJid, text, displayName, userJid, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, queueKey, accountName, chatJid, text, displayName, userJid, timestamp, JSON.stringify(metadata)],
      (err) => {
        if (err) {
          logger.error("[PENDING_QUEUE DB] Erro ao salvar mensagem pendente:", err);
          return reject(err);
        }
        resolve();
      }
    );
  });
}

export function clearPendingMessagesForQueue(queueKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM pending_messages WHERE queueKey = ?`, [queueKey], (err) => {
      if (err) {
        logger.error("[PENDING_QUEUE DB] Erro ao limpar mensagens pendentes da fila:", err);
        return reject(err);
      }
      resolve();
    });
  });
}

export function getAllPendingMessages(): Promise<PersistedBufferedMessage[]> {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM pending_messages ORDER BY timestamp ASC`, [], (err, rows) => {
      if (err) {
        logger.error("[PENDING_QUEUE DB] Erro ao buscar mensagens pendentes:", err);
        return reject(err);
      }
      resolve(rows as PersistedBufferedMessage[]);
    });
  });
}
