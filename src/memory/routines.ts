import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { getEquivalentJids } from '../utils/jidResolver.js';

export function ensureRoutinesTable(): void {
  const db = getDb();
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
  });
}

// Initial table creation
ensureRoutinesTable();

export interface Routine {
  id: number;
  chatJid: string;
  topicId?: string;
  cronExpression: string;
  prompt: string;
  isActive: boolean;
}

export function saveRoutine(chatJid: string, cronExpression: string, prompt: string, topicId?: string): Promise<Routine> {
  ensureRoutinesTable();
  return new Promise((resolve, reject) => {
    getDb().run(
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

export function getRoutineById(id: number): Promise<Routine | null> {
  ensureRoutinesTable();
  return new Promise((resolve, reject) => {
    getDb().get(`SELECT * FROM routines WHERE id = ?`, [id], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      const r = row as any;
      resolve({
        ...r,
        isActive: Boolean(r.isActive)
      });
    });
  });
}

export function getAllActiveRoutines(): Promise<Routine[]> {
  ensureRoutinesTable();
  return new Promise((resolve, reject) => {
    getDb().all(`SELECT * FROM routines WHERE isActive = 1`, (err, rows) => {
      if (err) return reject(err);
      resolve((rows as any[]).map(r => ({ ...r, isActive: Boolean(r.isActive) })));
    });
  });
}

export function getRoutinesForChat(chatJid: string, topicId?: string): Promise<Routine[]> {
  ensureRoutinesTable();
  return new Promise((resolve, reject) => {
    const equivalents = getEquivalentJids(chatJid);
    const placeholders = equivalents.map(() => '?').join(',');
    let sql = `SELECT * FROM routines WHERE chatJid IN (${placeholders}) AND isActive = 1`;
    const params: any[] = [...equivalents];
    
    if (topicId) {
      sql += ` AND topicId = ?`;
      params.push(topicId);
    }
    
    getDb().all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve((rows as any[]).map(r => ({ ...r, isActive: Boolean(r.isActive) })));
    });
  });
}

export function updateRoutine(
  id: number,
  updates: { cronExpression?: string; prompt?: string; isActive?: boolean }
): Promise<Routine | null> {
  ensureRoutinesTable();
  return new Promise((resolve, reject) => {
    const sets: string[] = [];
    const params: any[] = [];
    if (updates.cronExpression !== undefined) {
      sets.push('cronExpression = ?');
      params.push(updates.cronExpression);
    }
    if (updates.prompt !== undefined) {
      sets.push('prompt = ?');
      params.push(updates.prompt);
    }
    if (updates.isActive !== undefined) {
      sets.push('isActive = ?');
      params.push(updates.isActive ? 1 : 0);
    }
    if (sets.length === 0) {
      return getRoutineById(id).then(resolve).catch(reject);
    }
    params.push(id);
    const sql = `UPDATE routines SET ${sets.join(', ')} WHERE id = ?`;
    getDb().run(sql, params, function (err) {
      if (err) return reject(err);
      if (this.changes === 0) return resolve(null);
      getRoutineById(id).then(resolve).catch(reject);
    });
  });
}

export function deleteRoutine(id: number): Promise<void> {
  ensureRoutinesTable();
  return new Promise((resolve, reject) => {
    getDb().run(`DELETE FROM routines WHERE id = ?`, [id], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export function deactivateRoutine(id: number): Promise<void> {
  ensureRoutinesTable();
  return new Promise((resolve, reject) => {
    getDb().run(`UPDATE routines SET isActive = 0 WHERE id = ?`, [id], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}


