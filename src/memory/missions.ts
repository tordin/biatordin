import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';
import { getEquivalentJids } from '../utils/jidResolver.js';

const db = new sqlite3.Database('database.sqlite', (err) => {
  if (err) {
    logger.error("[MISSIONS DB] Erro ao conectar no SQLite:", err);
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      masterJid TEXT NOT NULL,
      targetJid TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`ALTER TABLE missions ADD COLUMN notes TEXT`, (err) => {
    if (err && !err.message.includes("duplicate column name")) {
      logger.error("[MISSIONS DB] Erro ao adicionar coluna notes:", err);
    }
  });
});

export interface Mission {
  id: number;
  masterJid: string;
  targetJid: string;
  objective: string;
  status: 'active' | 'completed' | 'cancelled';
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function saveMission(masterJid: string, targetJid: string, objective: string): Promise<Mission> {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare("INSERT INTO missions (masterJid, targetJid, objective, status) VALUES (?, ?, ?, 'active')");
    stmt.run(masterJid, targetJid, objective, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      resolve(getMissionById(this.lastID));
    });
    stmt.finalize();
  });
}

export function getMissionById(id: number): Promise<Mission> {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM missions WHERE id = ?", [id], (err, row: Mission) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

export function getActiveMissionsForTarget(targetJid: string): Promise<Mission[]> {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM missions WHERE targetJid = ? AND status = 'active' ORDER BY createdAt DESC", [targetJid], (err, rows: Mission[]) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/** Retorna a missão ativa mais recente de um master com um target (considerando LID↔número). */
export function findActiveMission(masterJid: string, targetJid: string): Promise<Mission | null> {
  const masterJids = getEquivalentJids(masterJid);
  const targetJids = getEquivalentJids(targetJid);
  const mPlaceholders = masterJids.map(() => '?').join(', ');
  const tPlaceholders = targetJids.map(() => '?').join(', ');
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM missions WHERE masterJid IN (${mPlaceholders}) AND targetJid IN (${tPlaceholders}) AND status = 'active' ORDER BY createdAt DESC LIMIT 1`,
      [...masterJids, ...targetJids],
      (err, row: Mission | undefined) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

export function getActiveMissionsForChat(chatJid: string): Promise<Mission[]> {
  const jids = getEquivalentJids(chatJid);
  const placeholders = jids.map(() => '?').join(', ');
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM missions WHERE (targetJid IN (${placeholders}) OR masterJid IN (${placeholders})) AND status = 'active' ORDER BY createdAt DESC`,
      [...jids, ...jids],
      (err, rows: Mission[]) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

export function getRecentMissionsForChat(chatJid: string, limit: number = 10): Promise<Mission[]> {
  const jids = getEquivalentJids(chatJid);
  const placeholders = jids.map(() => '?').join(', ');
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM missions WHERE (targetJid IN (${placeholders}) OR masterJid IN (${placeholders})) ORDER BY createdAt DESC LIMIT ?`,
      [...jids, ...jids, limit],
      (err, rows: Mission[]) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

export function hasActiveMissionForTarget(targetJid: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.get("SELECT 1 FROM missions WHERE targetJid = ? AND status = 'active' LIMIT 1", [targetJid], (err, row) => {
      if (err) return reject(err);
      resolve(!!row);
    });
  });
}

export function listActiveMissions(masterJid: string): Promise<Mission[]> {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM missions WHERE masterJid = ? AND status = 'active' ORDER BY createdAt DESC", [masterJid], (err, rows: Mission[]) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export function getRecentMissionsForMaster(masterJid: string, limit: number = 15): Promise<Mission[]> {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM missions WHERE masterJid = ? ORDER BY createdAt DESC LIMIT ?", [masterJid, limit], (err, rows: Mission[]) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export function getRecentMissionsByTarget(masterJid: string, targetJid: string, limit: number = 15): Promise<Mission[]> {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM missions WHERE masterJid = ? AND targetJid = ? ORDER BY createdAt DESC LIMIT ?", [masterJid, targetJid, limit], (err, rows: Mission[]) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export function completeMission(id: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare("UPDATE missions SET status = 'completed', updatedAt = CURRENT_TIMESTAMP WHERE id = ?");
    stmt.run(id, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
    stmt.finalize();
  });
}

export function updateMissionNotes(id: number, notes: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare("UPDATE missions SET notes = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?");
    stmt.run(notes, id, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
    stmt.finalize();
  });
}
