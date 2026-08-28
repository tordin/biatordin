import sqlite3 from 'sqlite3';
import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { getEquivalentJids, jidsMatch } from '../utils/jidResolver.js';

const db = getDb();


export type FollowUpType = 'waiting_for_them' | 'promised_by_me';
export type FollowUpStatus = 'pending' | 'resolved' | 'cancelled' | 'overdue';
export type FollowUpOrigin = 'direct' | 'chat_jid' | 'mission_id' | 'passive_observer';

export interface FollowUp {
  id: number;
  type: FollowUpType;
  contactName: string;
  contactJid?: string | null;
  description: string;
  dueDate?: string | null;
  status: FollowUpStatus;
  contextOrigin: FollowUpOrigin;
  chatJid?: string | null;
  missionId?: number | null;
  lastNotifiedAt?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFollowUpDTO {
  type: FollowUpType;
  contactName: string;
  contactJid?: string | null;
  description: string;
  dueDate?: string | null;
  status?: FollowUpStatus;
  contextOrigin?: FollowUpOrigin;
  chatJid?: string | null;
  missionId?: number | null;
  notes?: string | null;
}

export interface FollowUpFilter {
  type?: FollowUpType | 'all';
  status?: FollowUpStatus | 'all' | 'active'; // 'active' includes 'pending' and 'overdue'
  contactName?: string;
  contactJid?: string;
  chatJid?: string;
  missionId?: number;
  limit?: number;
}

export function initFollowUpsTable(): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS followups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          contactName TEXT NOT NULL,
          contactJid TEXT,
          description TEXT NOT NULL,
          dueDate DATETIME,
          status TEXT NOT NULL DEFAULT 'pending',
          contextOrigin TEXT NOT NULL DEFAULT 'direct',
          chatJid TEXT,
          missionId INTEGER,
          lastNotifiedAt DATETIME,
          notes TEXT,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          logger.error("[FOLLOWUPS DB] Erro ao criar tabela followups:", err);
          return reject(err);
        }
        resolve();
      });

      // Indexes for fast querying by status, type and contact
      db.run(`CREATE INDEX IF NOT EXISTS idx_followups_status_type ON followups(status, type)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_followups_contact_jid ON followups(contactJid)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_followups_chat_jid ON followups(chatJid)`);
    });
  });
}

// Auto-run table creation at module load
initFollowUpsTable().catch(err => {
  logger.error("[FOLLOWUPS DB] Falha na inicialização da tabela de follow-ups:", err);
});

export function saveFollowUp(data: CreateFollowUpDTO): Promise<FollowUp> {
  return new Promise((resolve, reject) => {
    const status = data.status || 'pending';
    const origin = data.contextOrigin || 'direct';
    const sql = `
      INSERT INTO followups (
        type, contactName, contactJid, description, dueDate,
        status, contextOrigin, chatJid, missionId, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      data.type,
      data.contactName,
      data.contactJid || null,
      data.description,
      data.dueDate || null,
      status,
      origin,
      data.chatJid || null,
      data.missionId || null,
      data.notes || null,
    ];

    db.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      getFollowUpById(this.lastID)
        .then(item => {
          if (!item) return reject(new Error("Follow-up recém-criado não foi encontrado."));
          resolve(item);
        })
        .catch(reject);
    });
  });
}

export function getFollowUpById(id: number): Promise<FollowUp | null> {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM followups WHERE id = ?", [id], (err, row: FollowUp | undefined) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

export function getFollowUps(filters: FollowUpFilter = {}): Promise<FollowUp[]> {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM followups WHERE 1=1`;
    const params: any[] = [];

    if (filters.type && filters.type !== 'all') {
      sql += ` AND type = ?`;
      params.push(filters.type);
    }

    if (filters.status && filters.status !== 'all') {
      if (filters.status === 'active') {
        sql += ` AND status IN ('pending', 'overdue')`;
      } else {
        sql += ` AND status = ?`;
        params.push(filters.status);
      }
    }

    if (filters.contactName) {
      sql += ` AND contactName LIKE ?`;
      params.push(`%${filters.contactName}%`);
    }

    if (filters.contactJid) {
      const jids = getEquivalentJids(filters.contactJid);
      const placeholders = jids.map(() => '?').join(', ');
      sql += ` AND contactJid IN (${placeholders})`;
      params.push(...jids);
    }

    if (filters.chatJid) {
      const jids = getEquivalentJids(filters.chatJid);
      const placeholders = jids.map(() => '?').join(', ');
      sql += ` AND chatJid IN (${placeholders})`;
      params.push(...jids);
    }

    if (filters.missionId) {
      sql += ` AND missionId = ?`;
      params.push(filters.missionId);
    }

    sql += ` ORDER BY CASE WHEN dueDate IS NULL THEN 1 ELSE 0 END, dueDate ASC, createdAt DESC`;

    if (filters.limit) {
      sql += ` LIMIT ?`;
      params.push(filters.limit);
    }

    db.all(sql, params, (err, rows: FollowUp[]) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

export function updateFollowUp(id: number, updates: Partial<FollowUp>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const fields: string[] = [];
    const params: any[] = [];

    const allowedKeys: (keyof FollowUp)[] = [
      'type', 'contactName', 'contactJid', 'description',
      'dueDate', 'status', 'contextOrigin', 'chatJid',
      'missionId', 'lastNotifiedAt', 'notes'
    ];

    for (const key of allowedKeys) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(updates[key]);
      }
    }

    if (fields.length === 0) {
      return resolve(false);
    }

    fields.push(`updatedAt = CURRENT_TIMESTAMP`);
    params.push(id);

    const sql = `UPDATE followups SET ${fields.join(', ')} WHERE id = ?`;

    db.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}

export function resolveFollowUp(id: number, notes?: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let sql = `
      UPDATE followups 
      SET status = 'resolved', 
          updatedAt = CURRENT_TIMESTAMP
    `;
    const params: any[] = [];

    if (notes) {
      sql += `, notes = CASE WHEN notes IS NULL THEN ? ELSE notes || '\n' || ? END`;
      params.push(notes, notes);
    }

    sql += ` WHERE id = ? AND status != 'resolved'`;
    params.push(id);

    db.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}

export function cancelFollowUp(id: number, notes?: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let sql = `
      UPDATE followups 
      SET status = 'cancelled', 
          updatedAt = CURRENT_TIMESTAMP
    `;
    const params: any[] = [];

    if (notes) {
      sql += `, notes = CASE WHEN notes IS NULL THEN ? ELSE notes || '\n' || ? END`;
      params.push(notes, notes);
    }

    sql += ` WHERE id = ? AND status != 'cancelled'`;
    params.push(id);

    db.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}

export function markFollowUpNotified(id: number): Promise<boolean> {
  return updateFollowUp(id, {
    lastNotifiedAt: new Date().toISOString()
  });
}

/**
 * Retorna pendências do tipo 'waiting_for_them' vencidas (dueDate <= now)
 * que ainda não foram resolvidas ou canceladas.
 */
export function getOverdueWaitingFollowUps(): Promise<FollowUp[]> {
  return new Promise((resolve, reject) => {
    const nowIso = new Date().toISOString();
    const sql = `
      SELECT * FROM followups 
      WHERE type = 'waiting_for_them'
        AND status IN ('pending', 'overdue')
        AND dueDate IS NOT NULL 
        AND dueDate <= ?
      ORDER BY dueDate ASC
    `;
    db.all(sql, [nowIso], (err, rows: FollowUp[]) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/**
 * Retorna compromissos 'promised_by_me' com vencimento próximo (nas próximas X horas ou hoje)
 * que ainda não foram notificados ou resolvidos.
 */
export function getUpcomingPromisedFollowUps(windowHours: number = 4): Promise<FollowUp[]> {
  return new Promise((resolve, reject) => {
    const maxDate = new Date(Date.now() + windowHours * 60 * 60 * 1000).toISOString();
    const sql = `
      SELECT * FROM followups 
      WHERE type = 'promised_by_me'
        AND status = 'pending'
        AND dueDate IS NOT NULL 
        AND dueDate <= ?
      ORDER BY dueDate ASC
    `;
    db.all(sql, [maxDate], (err, rows: FollowUp[]) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/**
 * Resolução automática inteligente:
 * Quando um contato responde em um chat ou grupo onde há um 'waiting_for_them' pendente,
 * localiza as pendências ativas correspondentes e as resolve automaticamente.
 */
export async function autoResolveFollowUpsForChat(
  chatJid: string,
  senderJid?: string,
  contactName?: string,
  messageText?: string
): Promise<FollowUp[]> {
  const activeFollowUps = await getFollowUps({ status: 'active', type: 'waiting_for_them' });
  const resolved: FollowUp[] = [];

  for (const item of activeFollowUps) {
    let match = false;

    // 1. Match por chatJid ou senderJid
    if (item.contactJid && senderJid && jidsMatch(item.contactJid, senderJid)) {
      match = true;
    } else if (item.chatJid && chatJid && jidsMatch(item.chatJid, chatJid)) {
      match = true;
    } else if (item.contactJid && chatJid && jidsMatch(item.contactJid, chatJid)) {
      match = true;
    }

    // 2. Match por nome do contato se chat for 1-1 e nome coincidir
    if (!match && contactName && item.contactName) {
      const cleanContact = contactName.toLowerCase().trim();
      const cleanItemName = item.contactName.toLowerCase().trim();
      if (cleanContact.includes(cleanItemName) || cleanItemName.includes(cleanContact)) {
        if (!chatJid.endsWith('@g.us')) {
          match = true;
        }
      }
    }

    if (match) {
      const resolutionNote = `[AUTO-RESOLVIDO]: Resposta recebida de ${contactName || senderJid || chatJid} em ${new Date().toLocaleString('pt-BR')}${messageText ? `: "${messageText.substring(0, 100)}"` : ''}`;
      const ok = await resolveFollowUp(item.id, resolutionNote);
      if (ok) {
        logger.info(`[FOLLOWUPS AUTO-RESOLVE] Pendência ID ${item.id} (${item.contactName} - ${item.description}) resolvida automaticamente por mensagem recebida.`);
        resolved.push({ ...item, status: 'resolved', notes: item.notes ? `${item.notes}\n${resolutionNote}` : resolutionNote });
      }
    }
  }

  return resolved;
}

/**
 * Exclui permanentemente uma pendência por ID (usado para manutenção ou testes).
 */
export function deleteFollowUp(id: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM followups WHERE id = ?", [id], function (err) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}
