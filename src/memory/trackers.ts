import { getDb } from './db.js';
import { logger } from '../utils/logger.js';

const db = getDb();


db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS trackers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatJid TEXT NOT NULL,
      topicId TEXT,
      name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      data TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

export interface Tracker {
  id: number;
  chatJid: string;
  topicId?: string;
  name: string;
  purpose: string;
  data: string; // JSON string
  createdAt: string;
  updatedAt: string;
}

export function createTracker(
  chatJid: string,
  name: string,
  purpose: string,
  data: string,
  topicId?: string
): Promise<Tracker> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO trackers (chatJid, topicId, name, purpose, data) VALUES (?, ?, ?, ?, ?)`,
      [chatJid, topicId || null, name, purpose, data],
      function (err) {
        if (err) return reject(err);
        resolve({
          id: this.lastID,
          chatJid,
          topicId,
          name,
          purpose,
          data,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    );
  });
}

export function getTracker(
  id: number,
  chatJid: string,
  isTrustedChat: boolean = true
): Promise<Tracker | null> {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM trackers WHERE id = ?`;
    const params: any[] = [id];

    if (!isTrustedChat && chatJid) {
      sql += ` AND chatJid = ?`;
      params.push(chatJid);
    }

    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      resolve(row as Tracker);
    });
  });
}

export function updateTracker(
  id: number,
  chatJid: string,
  data: string,
  isTrustedChat: boolean = true
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let sql = `UPDATE trackers SET data = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`;
    const params: any[] = [data, id];

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

export function listTrackers(
  chatJid: string,
  isTrustedChat: boolean = true,
  topicId?: string
): Promise<Tracker[]> {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM trackers`;
    const params: any[] = [];

    if (!isTrustedChat && chatJid) {
      sql += ` WHERE chatJid = ?`;
      params.push(chatJid);
    } else {
      sql += ` WHERE 1=1`;
    }

    if (topicId) {
      sql += ` AND topicId = ?`;
      params.push(topicId);
    }

    sql += ` ORDER BY updatedAt DESC`;

    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows as Tracker[]);
    });
  });
}

export function deleteTracker(
  id: number,
  chatJid: string,
  isTrustedChat: boolean = true
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let sql = `DELETE FROM trackers WHERE id = ?`;
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
