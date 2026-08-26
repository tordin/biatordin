import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';

const db = new sqlite3.Database('database.sqlite', (err) => {
  if (err) {
    logger.error("[EMAIL_SENTINEL DB] Erro ao conectar no SQLite:", err);
  }
});

export interface SentinelRule {
  id: number;
  type: 'ignore' | 'priority' | 'learning';
  pattern: string;
  target: 'sender' | 'domain' | 'subject' | 'general';
  reason?: string;
  createdAt: string;
}

export interface ProcessedEmailLog {
  id: number;
  emailId: string;
  threadId?: string;
  sender?: string;
  subject?: string;
  snippet?: string;
  classification: 'ignored_heuristic' | 'ignored_llm' | 'important' | 'alerted';
  reason?: string;
  processedAt: string;
}

export function initEmailSentinelTables(): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS email_sentinel_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          pattern TEXT NOT NULL,
          target TEXT NOT NULL DEFAULT 'general',
          reason TEXT,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          logger.error("[EMAIL_SENTINEL DB] Erro ao criar tabela email_sentinel_rules:", err);
          return reject(err);
        }
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS email_sentinel_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          emailId TEXT NOT NULL UNIQUE,
          threadId TEXT,
          sender TEXT,
          subject TEXT,
          snippet TEXT,
          classification TEXT NOT NULL,
          reason TEXT,
          processedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          logger.error("[EMAIL_SENTINEL DB] Erro ao criar tabela email_sentinel_log:", err);
          return reject(err);
        }
        logger.info("[EMAIL_SENTINEL DB] Tabelas do Sentinela de E-mail inicializadas com sucesso.");
        resolve();
      });
    });
  });
}

export function addSentinelRule(
  type: 'ignore' | 'priority' | 'learning',
  pattern: string,
  target: 'sender' | 'domain' | 'subject' | 'general' = 'general',
  reason?: string
): Promise<SentinelRule> {
  return new Promise((resolve, reject) => {
    const normalizedPattern = pattern.trim().toLowerCase();
    db.run(
      `INSERT INTO email_sentinel_rules (type, pattern, target, reason) VALUES (?, ?, ?, ?)`,
      [type, normalizedPattern, target, reason || null],
      function (err) {
        if (err) {
          logger.error("[EMAIL_SENTINEL DB] Erro ao adicionar regra:", err);
          return reject(err);
        }
        resolve({
          id: this.lastID,
          type,
          pattern: normalizedPattern,
          target,
          reason,
          createdAt: new Date().toISOString(),
        });
      }
    );
  });
}

export function getSentinelRules(typeFilter?: 'ignore' | 'priority' | 'learning'): Promise<SentinelRule[]> {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM email_sentinel_rules`;
    const params: any[] = [];

    if (typeFilter) {
      sql += ` WHERE type = ?`;
      params.push(typeFilter);
    }

    sql += ` ORDER BY createdAt DESC`;

    db.all(sql, params, (err, rows) => {
      if (err) {
        logger.error("[EMAIL_SENTINEL DB] Erro ao buscar regras:", err);
        return reject(err);
      }
      resolve(rows as SentinelRule[]);
    });
  });
}

export function deleteSentinelRule(id: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM email_sentinel_rules WHERE id = ?`,
      [id],
      function (err) {
        if (err) {
          logger.error(`[EMAIL_SENTINEL DB] Erro ao excluir regra ID ${id}:`, err);
          return reject(err);
        }
        resolve(this.changes > 0);
      }
    );
  });
}

export function isEmailProcessed(emailId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM email_sentinel_log WHERE emailId = ?`,
      [emailId],
      (err, row) => {
        if (err) {
          logger.error(`[EMAIL_SENTINEL DB] Erro ao verificar processamento do e-mail ${emailId}:`, err);
          return reject(err);
        }
        resolve(!!row);
      }
    );
  });
}

export function areEmailsProcessed(emailIds: string[]): Promise<Set<string>> {
  if (emailIds.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    const placeholders = emailIds.map(() => '?').join(',');
    db.all(
      `SELECT emailId FROM email_sentinel_log WHERE emailId IN (${placeholders})`,
      emailIds,
      (err, rows) => {
        if (err) {
          logger.error("[EMAIL_SENTINEL DB] Erro ao verificar lista de e-mails processados:", err);
          return reject(err);
        }
        const processedSet = new Set<string>((rows as any[]).map(r => r.emailId));
        resolve(processedSet);
      }
    );
  });
}

export function recordProcessedEmail(log: {
  emailId: string;
  threadId?: string;
  sender?: string;
  subject?: string;
  snippet?: string;
  classification: 'ignored_heuristic' | 'ignored_llm' | 'important' | 'alerted';
  reason?: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO email_sentinel_log (emailId, threadId, sender, subject, snippet, classification, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        log.emailId,
        log.threadId || null,
        log.sender || null,
        log.subject || null,
        log.snippet || null,
        log.classification,
        log.reason || null,
      ],
      (err) => {
        if (err) {
          logger.error(`[EMAIL_SENTINEL DB] Erro ao registrar log do e-mail ${log.emailId}:`, err);
          return reject(err);
        }
        resolve();
      }
    );
  });
}

export function recordProcessedEmailsBatch(logs: Array<{
  emailId: string;
  threadId?: string;
  sender?: string;
  subject?: string;
  snippet?: string;
  classification: 'ignored_heuristic' | 'ignored_llm' | 'important' | 'alerted';
  reason?: string;
}>): Promise<void> {
  if (logs.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO email_sentinel_log (emailId, threadId, sender, subject, snippet, classification, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const log of logs) {
        stmt.run([
          log.emailId,
          log.threadId || null,
          log.sender || null,
          log.subject || null,
          log.snippet || null,
          log.classification,
          log.reason || null,
        ]);
      }

      stmt.finalize((err) => {
        if (err) {
          db.run("ROLLBACK");
          logger.error("[EMAIL_SENTINEL DB] Erro ao finalizar batch insert de logs:", err);
          return reject(err);
        }
        db.run("COMMIT", (commitErr) => {
          if (commitErr) {
            logger.error("[EMAIL_SENTINEL DB] Erro ao commitar batch insert de logs:", commitErr);
            return reject(commitErr);
          }
          resolve();
        });
      });
    });
  });
}

export interface SentinelStats {
  totalProcessed: number;
  ignoredHeuristic: number;
  ignoredLlm: number;
  important: number;
  alerted: number;
  since?: string;
}

export function getSentinelStats(dateFilter?: string): Promise<SentinelStats> {
  return new Promise((resolve, reject) => {
    let sql = `
      SELECT
        COUNT(*) as totalProcessed,
        SUM(CASE WHEN classification = 'ignored_heuristic' THEN 1 ELSE 0 END) as ignoredHeuristic,
        SUM(CASE WHEN classification = 'ignored_llm' THEN 1 ELSE 0 END) as ignoredLlm,
        SUM(CASE WHEN classification = 'important' THEN 1 ELSE 0 END) as important,
        SUM(CASE WHEN classification = 'alerted' THEN 1 ELSE 0 END) as alerted
      FROM email_sentinel_log
    `;
    const params: any[] = [];
    if (dateFilter) {
      sql += ` WHERE date(processedAt, 'localtime') = date(?, 'localtime')`;
      params.push(dateFilter);
    }

    db.get(sql, params, (err, row: any) => {
      if (err) {
        logger.error("[EMAIL_SENTINEL DB] Erro ao obter estatísticas:", err);
        return reject(err);
      }
      resolve({
        totalProcessed: row?.totalProcessed || 0,
        ignoredHeuristic: row?.ignoredHeuristic || 0,
        ignoredLlm: row?.ignoredLlm || 0,
        important: row?.important || 0,
        alerted: row?.alerted || 0,
        since: dateFilter,
      });
    });
  });
}

export function getRecentProcessedEmails(
  limit: number = 20,
  filter?: { classification?: string; todayOnly?: boolean }
): Promise<ProcessedEmailLog[]> {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM email_sentinel_log`;
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter?.classification && filter.classification !== 'all') {
      conditions.push(`classification = ?`);
      params.push(filter.classification);
    }

    if (filter?.todayOnly) {
      conditions.push(`date(processedAt, 'localtime') = date('now', 'localtime')`);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(' AND ');
    }

    sql += ` ORDER BY processedAt DESC LIMIT ?`;
    params.push(limit);

    db.all(sql, params, (err, rows) => {
      if (err) {
        logger.error("[EMAIL_SENTINEL DB] Erro ao buscar histórico de e-mails processados:", err);
        return reject(err);
      }
      resolve(rows as ProcessedEmailLog[]);
    });
  });
}
