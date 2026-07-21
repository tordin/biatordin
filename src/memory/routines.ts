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
      cronExpression TEXT NOT NULL,
      prompt TEXT NOT NULL,
      isActive BOOLEAN NOT NULL DEFAULT 1
    )
  `);
});

export interface Routine {
  id: number;
  chatJid: string;
  cronExpression: string;
  prompt: string;
  isActive: boolean;
}

export function saveRoutine(chatJid: string, cronExpression: string, prompt: string): Promise<Routine> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO routines (chatJid, cronExpression, prompt, isActive) VALUES (?, ?, ?, ?)`,
      [chatJid, cronExpression, prompt, 1],
      function (err) {
        if (err) return reject(err);
        resolve({
          id: this.lastID,
          chatJid,
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

export function getRoutinesForChat(chatJid: string): Promise<Routine[]> {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM routines WHERE chatJid = ? AND isActive = 1`, [chatJid], (err, rows) => {
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
