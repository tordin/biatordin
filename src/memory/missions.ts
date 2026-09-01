import sqlite3 from 'sqlite3';
import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { getEquivalentJids } from '../utils/jidResolver.js';

const db = getDb();


db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      masterJid TEXT NOT NULL,
      targetJid TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      expiresAt DATETIME,
      ttlHours INTEGER,
      topicId TEXT
    )
  `);

  db.run(`ALTER TABLE missions ADD COLUMN notes TEXT`, (err) => {
    if (err && !err.message.includes("duplicate column name")) {
      logger.error("[MISSIONS DB] Erro ao adicionar coluna notes:", err);
    }
  });

  db.run(`ALTER TABLE missions ADD COLUMN expiresAt DATETIME`, (err) => {
    if (err && !err.message.includes("duplicate column name")) {
      logger.error("[MISSIONS DB] Erro ao adicionar coluna expiresAt:", err);
    }
  });

  db.run(`ALTER TABLE missions ADD COLUMN ttlHours INTEGER`, (err) => {
    if (err && !err.message.includes("duplicate column name")) {
      logger.error("[MISSIONS DB] Erro ao adicionar coluna ttlHours:", err);
    }
  });

  db.run(`ALTER TABLE missions ADD COLUMN topicId TEXT`, (err) => {
    if (err && !err.message.includes("duplicate column name")) {
      logger.error("[MISSIONS DB] Erro ao adicionar coluna topicId:", err);
    }
  });

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_mission ON missions(masterJid, targetJid) WHERE status = 'active'`, (err) => {
    if (err && !err.message.includes("already exists")) {
      logger.error("[MISSIONS DB] Erro ao criar índice único de missões ativas:", err);
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
  expiresAt?: string | null;
  ttlHours?: number | null;
  topicId?: string | null;
}

export function expireOldMissions(): Promise<void> {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      UPDATE missions 
      SET status = 'cancelled', 
          notes = CASE WHEN notes IS NULL THEN 'Missão expirada por tempo limite.' ELSE notes || '\n\n[SISTEMA]: Missão expirada por tempo limite.' END,
          updatedAt = CURRENT_TIMESTAMP
      WHERE status = 'active' AND expiresAt IS NOT NULL AND expiresAt < CURRENT_TIMESTAMP
    `);
    stmt.run([], function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      if (this.changes > 0) {
        logger.info(`[MISSIONS DB] ${this.changes} missões expiradas automaticamente.`);
      }
      resolve();
    });
    stmt.finalize();
  });
}

export function saveMission(masterJid: string, targetJid: string, objective: string, ttlHours: number = 72, topicId?: string): Promise<Mission> {
  return new Promise((resolve, reject) => {
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    const stmt = db.prepare("INSERT INTO missions (masterJid, targetJid, objective, status, ttlHours, expiresAt, topicId) VALUES (?, ?, ?, 'active', ?, ?, ?)");
    stmt.run(masterJid, targetJid, objective, ttlHours, expiresAt, topicId || null, function (this: sqlite3.RunResult, err: Error | null) {
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

export async function getActiveMissionsForTarget(targetJid: string): Promise<Mission[]> {
  await expireOldMissions();
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM missions WHERE targetJid = ? AND status = 'active' ORDER BY createdAt DESC", [targetJid], (err, rows: Mission[]) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/** Retorna a missão ativa mais recente de um master com um target (considerando LID↔número). */
export async function findActiveMission(masterJid: string, targetJid: string): Promise<Mission | null> {
  await expireOldMissions();
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

export async function getActiveMissionsForChat(chatJid: string): Promise<Mission[]> {
  await expireOldMissions();
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

export async function hasActiveMissionForTarget(targetJid: string): Promise<boolean> {
  await expireOldMissions();
  return new Promise((resolve, reject) => {
    db.get("SELECT 1 FROM missions WHERE targetJid = ? AND status = 'active' LIMIT 1", [targetJid], (err, row) => {
      if (err) return reject(err);
      resolve(!!row);
    });
  });
}

export async function listActiveMissions(masterJid: string): Promise<Mission[]> {
  await expireOldMissions();
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
