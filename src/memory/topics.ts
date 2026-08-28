import { getDb } from './db.js';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const db = getDb();

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      chatJid TEXT NOT NULL,
      title TEXT NOT NULL,
      lastActive INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);
});

export interface Topic {

  id: string;
  chatJid: string;
  title: string;
  lastActive: number;
  status: 'active' | 'archived';
}

export function initTopicsTable(): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        chatJid TEXT NOT NULL,
        title TEXT NOT NULL,
        lastActive INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `, (err) => {
      if (err) {
        logger.error("[TOPICS DB] Erro ao criar tabela de tópicos:", err);
        return reject(err);
      }
      logger.info("[TOPICS DB] Tabela de tópicos inicializada.");
      resolve();
    });
  });
}

export function getRecentTopics(chatJid: string, limit = 20): Promise<Topic[]> {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM topics WHERE (chatJid = ? OR chatJid = 'global') AND status = 'active' ORDER BY lastActive DESC LIMIT ?`,
      [chatJid, limit],
      (err, rows) => {
        if (err) {
          logger.error("[TOPICS DB] Erro ao buscar tópicos recentes:", err);
          return reject(err);
        }
        resolve(rows as Topic[]);
      }
    );
  });
}

export function getTopic(topicId: string): Promise<Topic | null> {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM topics WHERE id = ?`,
      [topicId],
      (err, row) => {
        if (err) {
          logger.error("[TOPICS DB] Erro ao obter tópico:", err);
          return reject(err);
        }
        resolve((row as Topic) || null);
      }
    );
  });
}

export function createTopic(chatJid: string, title: string): Promise<Topic> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const lastActive = Date.now();
    const status = 'active';

    db.run(
      `INSERT INTO topics (id, chatJid, title, lastActive, status) VALUES (?, ?, ?, ?, ?)`,
      [id, chatJid, title, lastActive, status],
      (err) => {
        if (err) {
          logger.error("[TOPICS DB] Erro ao criar novo tópico:", err);
          return reject(err);
        }
        logger.info(`[TOPICS DB] Novo tópico criado: "${title}" (ID: ${id}) para chat ${chatJid}`);
        resolve({ id, chatJid, title, lastActive, status });
      }
    );
  });
}

export function getOrCreateTopicByTitle(chatJid: string, title: string): Promise<Topic> {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM topics WHERE chatJid = ? AND title = ? COLLATE NOCASE AND status = 'active'`,
      [chatJid, title],
      async (err, row) => {
        if (err) return reject(err);
        if (row) {
          resolve(row as Topic);
        } else {
          try {
            const newTopic = await createTopic(chatJid, title);
            resolve(newTopic);
          } catch (e) {
            reject(e);
          }
        }
      }
    );
  });
}

export function updateTopicActivity(topicId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const lastActive = Date.now();
    db.run(
      `UPDATE topics SET lastActive = ? WHERE id = ?`,
      [lastActive, topicId],
      (err) => {
        if (err) {
          logger.error("[TOPICS DB] Erro ao atualizar atividade do tópico:", err);
          return reject(err);
        }
        resolve();
      }
    );
  });
}
