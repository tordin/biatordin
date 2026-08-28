import { getDb } from './db.js';
import { logger } from "../utils/logger.js";

const db = getDb();


export function initializeDailySummaryDB(): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS daily_summary_groups (
          jid TEXT PRIMARY KEY,
          addedAt INTEGER NOT NULL
      )`,
      (err: any) => {
        if (err) {
          logger.error("[DAILY SUMMARY DB] Erro ao criar tabela daily_summary_groups:", err);
          return reject(err);
        }
        resolve();
      }
    );
  });
}

export function isDailySummaryGroup(jid: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM daily_summary_groups WHERE jid = ?`,
      [jid],
      (err: any, row: any) => {
        if (err) {
          logger.error("[DAILY SUMMARY DB] Erro ao verificar grupo de resumo diário:", err);
          return reject(err);
        }
        resolve(!!row);
      }
    );
  });
}

export function addDailySummaryGroup(jid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const addedAt = Date.now();
    db.run(
      `INSERT OR IGNORE INTO daily_summary_groups (jid, addedAt) VALUES (?, ?)`,
      [jid, addedAt],
      (err: any) => {
        if (err) {
          logger.error("[DAILY SUMMARY DB] Erro ao adicionar grupo de resumo diário:", err);
          return reject(err);
        }
        logger.info(`[DAILY SUMMARY DB] Grupo ${jid} adicionado aos grupos de resumo diário.`);
        resolve();
      }
    );
  });
}

export function removeDailySummaryGroup(jid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM daily_summary_groups WHERE jid = ?`,
      [jid],
      (err: any) => {
        if (err) {
          logger.error("[DAILY SUMMARY DB] Erro ao remover grupo de resumo diário:", err);
          return reject(err);
        }
        logger.info(`[DAILY SUMMARY DB] Grupo ${jid} removido dos grupos de resumo diário.`);
        resolve();
      }
    );
  });
}

export function listDailySummaryGroups(): Promise<{ jid: string; addedAt: number }[]> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT jid, addedAt FROM daily_summary_groups`,
      (err: any, rows: any) => {
        if (err) {
          logger.error("[DAILY SUMMARY DB] Erro ao listar grupos de resumo diário:", err);
          return reject(err);
        }
        resolve(rows as { jid: string; addedAt: number }[]);
      }
    );
  });
}
