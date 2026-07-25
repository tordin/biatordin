import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';

// We use the same SQLite database as LangGraph checkpoint
const db = new sqlite3.Database('database.sqlite', (err) => {
  if (err) {
    logger.error("[ROUTINES DB] Erro ao conectar no SQLite:", err);
  }
});

// Create table if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatJid TEXT NOT NULL,
      topicId TEXT,
      cronExpression TEXT NOT NULL,
      prompt TEXT NOT NULL,
      isActive BOOLEAN NOT NULL DEFAULT 1
    )
  `);

  // Migrate existing table to add topicId if it doesn't exist
  db.all("PRAGMA table_info(routines)", (err, rows: any[]) => {
    if (!err && rows) {
      const hasTopicId = rows.some(row => row.name === 'topicId');
      if (!hasTopicId) {
        db.run("ALTER TABLE routines ADD COLUMN topicId TEXT", (alterErr) => {
          if (alterErr) logger.error("[ROUTINES DB] Erro ao adicionar coluna topicId:", alterErr);
          else logger.info("[ROUTINES DB] Coluna topicId adicionada com sucesso.");
        });
      }
    }
  });
});

export interface Routine {
  id: number;
  chatJid: string;
  topicId?: string;
  cronExpression: string;
  prompt: string;
  isActive: boolean;
}

export function saveRoutine(chatJid: string, cronExpression: string, prompt: string, topicId?: string): Promise<Routine> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO routines (chatJid, topicId, cronExpression, prompt, isActive) VALUES (?, ?, ?, ?, ?)`,
      [chatJid, topicId || null, cronExpression, prompt, 1],
      function (err) {
        if (err) return reject(err);
        resolve({
          id: this.lastID,
          chatJid,
          topicId,
          cronExpression,
          prompt,
          isActive: true
        });
      }
    );
  });
}

export function getAllActiveRoutines(): Promise<Routine[]> {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM routines WHERE isActive = 1`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows as Routine[]);
    });
  });
}

export function getRoutinesForChat(chatJid: string, topicId?: string): Promise<Routine[]> {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM routines WHERE chatJid = ? AND isActive = 1`;
    const params: any[] = [chatJid];
    
    if (topicId) {
      sql += ` AND topicId = ?`;
      params.push(topicId);
    }
    
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows as Routine[]);
    });
  });
}

export function deleteRoutine(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM routines WHERE id = ?`, [id], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export function deactivateRoutine(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE routines SET isActive = 0 WHERE id = ?`, [id], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
