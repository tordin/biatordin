import sqlite3 from 'sqlite3';
import { getDb } from './db.js';
import { logger } from '../utils/logger.js';
import { getOrCreateTopicByTitle, getTopic } from './topics.js';

const db = getDb();

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS context_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      max_characters INTEGER DEFAULT 6000,
      last_compacted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_context_docs_topic ON context_documents(topic_id)`);
});

export interface ContextDocument {
  id: number;
  topic_id: string;
  title: string;
  content: string;
  max_characters: number;
  last_compacted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function initContextDocumentsTable(): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS context_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_id TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          max_characters INTEGER DEFAULT 6000,
          last_compacted_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) {
          logger.error("[CONTEXT DOCS] Erro ao criar tabela context_documents:", err);
          return reject(err);
        }
      });

      db.run(`CREATE INDEX IF NOT EXISTS idx_context_docs_topic ON context_documents(topic_id)`, (err) => {
        if (err) {
          logger.error("[CONTEXT DOCS] Erro ao criar índice idx_context_docs_topic:", err);
          return reject(err);
        }
        resolve();
      });
    });
  });
}

export async function resolveTopicId(chatJid: string, topicTitleOrId: string): Promise<{ topicId: string, title: string }> {
  try {
    const topic = await getTopic(topicTitleOrId);
    if (topic) return { topicId: topic.id, title: topic.title };
  } catch (e) {
    // ignore
  }
  
  const newTopic = await getOrCreateTopicByTitle(chatJid, topicTitleOrId);
  return { topicId: newTopic.id, title: newTopic.title };
}

export function getContextDocument(topicId: string): Promise<ContextDocument | null> {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT * FROM context_documents WHERE topic_id = ?",
      [topicId],
      (err, row: ContextDocument) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

export function saveContextDocument(topicId: string, title: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO context_documents (topic_id, title, content, updated_at) 
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(topic_id) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP`,
      [topicId, title, content],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

export function appendToContextDocument(topicId: string, title: string, textToAppend: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO context_documents (topic_id, title, content, updated_at) 
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(topic_id) DO UPDATE SET content = content || '\n' || excluded.content, updated_at = CURRENT_TIMESTAMP`,
      [topicId, title, textToAppend],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}
