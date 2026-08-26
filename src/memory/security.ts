import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';
import dotenv from 'dotenv';
dotenv.config();

const db = new sqlite3.Database('database.sqlite', (err) => {
  if (err) {
    logger.error("[SECURITY DB] Erro ao conectar no SQLite:", err);
  }
});

export const MASTER_NUMBER = process.env.MASTER_NUMBER || "5519997064504@s.whatsapp.net";
export const MASTER_JIDS = [MASTER_NUMBER, "233070879867118@lid"];



export function initSecurityTable(): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS trusted_chats (
          jid TEXT PRIMARY KEY,
          addedAt INTEGER NOT NULL
        )
      `, (err) => {
        if (err) {
          logger.error("[SECURITY DB] Erro ao criar tabela de chats de confiança:", err);
          return reject(err);
        }
        logger.info("[SECURITY DB] Tabela de chats de confiança inicializada.");

        resolve();
      });
    });
  });
}

export function isTrustedChat(jid: string): Promise<boolean> {
  if (MASTER_JIDS.includes(jid)) return Promise.resolve(true);
  
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM trusted_chats WHERE jid = ?`,
      [jid],
      (err, row) => {
        if (err) {
          logger.error("[SECURITY DB] Erro ao verificar confiança do chat:", err);
          return reject(err);
        }
        resolve(!!row);
      }
    );
  });
}

export function addTrustedChat(jid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const addedAt = Date.now();
    db.run(
      `INSERT OR IGNORE INTO trusted_chats (jid, addedAt) VALUES (?, ?)`,
      [jid, addedAt],
      (err) => {
        if (err) {
          logger.error("[SECURITY DB] Erro ao adicionar chat de confiança:", err);
          return reject(err);
        }
        logger.info(`[SECURITY DB] Chat ${jid} adicionado aos de confiança.`);
        resolve();
      }
    );
  });
}

export function removeTrustedChat(jid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM trusted_chats WHERE jid = ?`,
      [jid],
      (err) => {
        if (err) {
          logger.error("[SECURITY DB] Erro ao remover chat de confiança:", err);
          return reject(err);
        }
        logger.info(`[SECURITY DB] Chat ${jid} removido dos de confiança.`);
        resolve();
      }
    );
  });
}

export function listTrustedChats(): Promise<{ jid: string; addedAt: number }[]> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT jid, addedAt FROM trusted_chats`,
      (err, rows) => {
        if (err) {
          logger.error("[SECURITY DB] Erro ao listar chats de confiança:", err);
          return reject(err);
        }
        resolve(rows as { jid: string; addedAt: number }[]);
      }
    );
  });
}



