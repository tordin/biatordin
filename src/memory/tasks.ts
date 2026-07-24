import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';

const db = new sqlite3.Database('database.sqlite', (err) => {
  if (err) {
    logger.error("[TASKS DB] Erro ao conectar no SQLite:", err);
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatJid TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Geral',
      urgency TEXT NOT NULL DEFAULT 'Média',
      dueDate TEXT,
      isCompleted BOOLEAN NOT NULL DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

export interface Task {
  id: number;
  chatJid: string;
  title: string;
  category: string;
  urgency: string;
  dueDate?: string;
  isCompleted: boolean;
  createdAt: string;
}

export function saveTask(
  chatJid: string,
  title: string,
  category: string = 'Geral',
  urgency: string = 'Média',
  dueDate?: string
): Promise<Task> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO tasks (chatJid, title, category, urgency, dueDate, isCompleted) VALUES (?, ?, ?, ?, ?, 0)`,
      [chatJid, title, category, urgency, dueDate || null],
      function (err) {
        if (err) return reject(err);
        resolve({
          id: this.lastID,
          chatJid,
          title,
          category,
          urgency,
          dueDate,
          isCompleted: false,
          createdAt: new Date().toISOString()
        });
      }
    );
  });
}

export function getTasksForChat(
  chatJid: string,
  statusFilter: 'pending' | 'completed' | 'all' = 'pending',
  categoryFilter?: string,
  isTrustedChat: boolean = true
): Promise<Task[]> {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM tasks`;
    const params: any[] = [];

    // Isolamento estrito de sandbox apenas para chats NÃO confiáveis
    if (!isTrustedChat && chatJid) {
      sql += ` WHERE chatJid = ?`;
      params.push(chatJid);
    } else {
      sql += ` WHERE 1=1`;
    }

    if (statusFilter === 'pending') {
      sql += ` AND isCompleted = 0`;
    } else if (statusFilter === 'completed') {
      sql += ` AND isCompleted = 1`;
    }

    if (categoryFilter) {
      sql += ` AND category LIKE ?`;
      params.push(`%${categoryFilter}%`);
    }

    sql += ` ORDER BY createdAt DESC`;

    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      const tasks = (rows as any[]).map(row => ({
        ...row,
        isCompleted: Boolean(row.isCompleted)
      }));
      resolve(tasks as Task[]);
    });
  });
}

export function markTaskCompleted(id: number, chatJid: string, isTrustedChat: boolean = true): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let sql = `UPDATE tasks SET isCompleted = 1 WHERE id = ?`;
    const params: any[] = [id];

    if (!isTrustedChat && chatJid) {
      sql += ` AND chatJid = ?`;
      params.push(chatJid);
    }

    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}

export function deleteTask(id: number, chatJid: string, isTrustedChat: boolean = true): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let sql = `DELETE FROM tasks WHERE id = ?`;
    const params: any[] = [id];

    if (!isTrustedChat && chatJid) {
      sql += ` AND chatJid = ?`;
      params.push(chatJid);
    }

    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}
