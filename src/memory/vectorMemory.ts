import sqlite3 from 'sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { generateEmbedding } from './embeddings.js';
import { arbitrateMemoryCandidate, ArbiterVerdict } from './semanticArbiter.js';
import { getDbPath } from './db.js';

let dbInstance: sqlite3.Database | null = null;
let currentVectorDbPath: string | null = null;
let isInitialized = false;

export interface VectorMemoryRecord {
  id: number;
  content: string;
  category: string;
  chatJid: string;
  createdAt: string;
  updatedAt: string;
  importance: number;
  accessCount: number;
  lastAccessedAt: string;
  metadata?: Record<string, any>;
  distance?: number;
  cognitiveScore?: number;
}

export function getVectorDB(): sqlite3.Database {
  const activeDbPath = getDbPath();
  if (dbInstance && currentVectorDbPath !== activeDbPath) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
    isInitialized = false;
  }

  if (!dbInstance) {
    currentVectorDbPath = activeDbPath;
    dbInstance = new sqlite3.Database(activeDbPath, (err) => {
      if (err) {
        logger.error(`[VECTOR_MEMORY] Erro ao abrir SQLite (${activeDbPath}):`, err);
      }
    });
    // Carrega a extensão sqlite-vec no SQLite
    try {
      sqliteVec.load(dbInstance as any);
      logger.info('[VECTOR_MEMORY] Extensão sqlite-vec carregada com sucesso.');
    } catch (e) {
      logger.error('[VECTOR_MEMORY] Falha ao carregar sqlite-vec:', e);
    }
  }
  return dbInstance;
}


/**
 * Inicializa as tabelas de memória de longo prazo e vetor no SQLite.
 */
export function initVectorMemory(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isInitialized) return resolve();

    const db = getVectorDB();

    db.serialize(() => {
      // 1. Tabela de metadados das memórias com suporte cognitivo
      db.run(`
        CREATE TABLE IF NOT EXISTS long_term_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT DEFAULT 'geral',
          chat_jid TEXT DEFAULT 'global',
          importance REAL DEFAULT 0.5,
          access_count INTEGER DEFAULT 1,
          last_accessed_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT
        )
      `, (err) => {
        if (err) {
          logger.error('[VECTOR_MEMORY] Erro ao criar tabela long_term_memories:', err);
          return reject(err);
        }

        // Migração síncrona de schema caso as novas colunas cognitivas ainda não existam
        db.all("PRAGMA table_info(long_term_memories)", (pragmaErr, columns: any[]) => {
          if (!pragmaErr && columns) {
            const colNames = columns.map(c => c.name);
            db.serialize(() => {
              if (!colNames.includes("importance")) {
                db.run("ALTER TABLE long_term_memories ADD COLUMN importance REAL DEFAULT 0.5");
              }
              if (!colNames.includes("access_count")) {
                db.run("ALTER TABLE long_term_memories ADD COLUMN access_count INTEGER DEFAULT 1");
              }
              if (!colNames.includes("last_accessed_at")) {
                db.run("ALTER TABLE long_term_memories ADD COLUMN last_accessed_at TEXT");
                db.run("UPDATE long_term_memories SET last_accessed_at = created_at WHERE last_accessed_at IS NULL");
              }

              // 2. Tabela para snapshot cacheado da Memória de Trabalho consolidada
              db.run(`
                CREATE TABLE IF NOT EXISTS working_memory_snapshot (
                  chat_jid TEXT PRIMARY KEY,
                  snapshot TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  metadata TEXT
                )
              `);

              // Check se vec_memories existe com schema antigo de 768 dimensões e recria
              db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_memories'", (vecMasterErr, row: any) => {
                if (row && row.sql && row.sql.includes("768")) {
                  logger.info("[VECTOR_MEMORY] Tabela vec_memories com 768 dims detectada. Atualizando esquema para 3072 dims...");
                  db.run("DROP TABLE vec_memories");
                }

                // 3. Tabela virtual de vetores do sqlite-vec (3072 dimensões para gemini-embedding-001)
                db.run(`
                  CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
                    embedding float[3072]
                  )
                `, (vErr) => {
                  if (vErr) {
                    logger.error('[VECTOR_MEMORY] Erro ao criar tabela virtual vec_memories:', vErr);
                    return reject(vErr);
                  }
                  isInitialized = true;
                  logger.info('[VECTOR_MEMORY] Tabelas RAG inicializadas com sucesso.');
                  resolve();
                });
              });
            });
          }
        });
      });
    });
  });
}

/**
 * Adiciona uma nova memória ao banco relacional e gera/insere seu vector embedding no sqlite-vec.
 */
export async function addVectorMemory(
  content: string,
  category: string = 'geral',
  chatJid: string = 'global',
  metadata?: Record<string, any>,
  importance: number = 0.5
): Promise<number> {
  await initVectorMemory();

  if (!content || !content.trim()) {
    throw new Error('Conteúdo da memória não pode ser vazio.');
  }

  const cleanContent = content.trim();
  const now = new Date().toISOString();
  const metaStr = metadata ? JSON.stringify(metadata) : null;
  const validImportance = Math.max(0.0, Math.min(1.0, typeof importance === 'number' ? importance : 0.5));

  // 1. Gera o embedding vetorial do texto (3072 dims)
  const embedding = await generateEmbedding(cleanContent);

  const db = getVectorDB();

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO long_term_memories (content, category, chat_jid, importance, access_count, last_accessed_at, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [cleanContent, category, chatJid, validImportance, now, now, now, metaStr],
      function (err) {
        if (err) {
          logger.error('[VECTOR_MEMORY] Erro ao inserir long_term_memories:', err);
          return reject(err);
        }

        const memoryId = this.lastID;

        const embeddingBuffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

        // 2. Insere na tabela vetorial vec_memories usando o mesmo rowid
        db.run(
          `INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)`,
          [memoryId, embeddingBuffer],
          (vecErr) => {
            if (vecErr) {
              logger.error(`[VECTOR_MEMORY] Erro ao inserir embedding no vec_memories para id ${memoryId}:`, vecErr);
              return reject(vecErr);
            }
            logger.info(`[VECTOR_MEMORY] Nova memória salva (ID: ${memoryId}, Categoria: ${category}, Importância: ${validImportance}, Chat: ${chatJid})`);
            resolve(memoryId);
          }
        );
      }
    );
  });
}

/**
 * Realiza busca semântica RAG por similaridade vetorial no sqlite-vec.
 */
export async function searchVectorMemory(
  query: string,
  limit: number = 5,
  chatJid?: string,
  isTrustedChat: boolean = true
): Promise<VectorMemoryRecord[]> {
  await initVectorMemory();

  if (!query || !query.trim()) {
    return [];
  }

  const queryEmbedding = await generateEmbedding(query.trim());
  const db = getVectorDB();
  const kLimit = Math.max(200, limit * 10);

  return new Promise((resolve, reject) => {
    // Consulta vetorial sqlite-vec exigindo "WHERE embedding MATCH ? AND k = ?"
    const sql = `
      SELECT 
        m.id, 
        m.content, 
        m.category, 
        m.chat_jid, 
        m.importance,
        m.access_count,
        m.last_accessed_at,
        m.created_at, 
        m.updated_at, 
        m.metadata, 
        v.distance
      FROM vec_memories v
      JOIN long_term_memories m ON m.id = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `;

    const queryBuffer = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);

    db.all(sql, [queryBuffer, kLimit], (err, rows: any[]) => {
      if (err) {
        logger.error('[VECTOR_MEMORY] Erro na busca semântica:', err);
        return reject(err);
      }

      if (!rows || rows.length === 0) {
        return resolve([]);
      }

      let results: VectorMemoryRecord[] = rows.map((r) => ({
        id: r.id,
        content: r.content,
        category: r.category,
        chatJid: r.chat_jid,
        importance: typeof r.importance === 'number' ? r.importance : 0.5,
        accessCount: r.access_count || 1,
        lastAccessedAt: r.last_accessed_at || r.created_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        distance: r.distance
      }));

      // Em chats confiáveis, permite acesso cruzado entre chats confiáveis e globais.
      // Em chats NÃO confiáveis, isola estritamente as memórias apenas do chatJid atual.
      if (!isTrustedChat && chatJid && chatJid !== 'unknown') {
        results = results.filter((m) => m.chatJid === chatJid || m.chatJid === 'global');
      }

      resolve(results.slice(0, limit));
    });
  });
}

/**
 * Reforça memórias acessadas/citadas: incrementa access_count, renova last_accessed_at e adiciona leve boost de importância.
 */
export async function reinforceMemory(ids: number[], boostImportance: number = 0.05): Promise<void> {
  if (!ids || ids.length === 0) return;
  await initVectorMemory();
  const db = getVectorDB();
  const now = new Date().toISOString();
  const placeholders = ids.map(() => '?').join(',');

  return new Promise((resolve) => {
    db.run(
      `UPDATE long_term_memories 
       SET access_count = access_count + 1, 
           last_accessed_at = ?, 
           importance = MIN(1.0, COALESCE(importance, 0.5) + ?)
       WHERE id IN (${placeholders})`,
      [now, boostImportance, ...ids],
      function (err) {
        if (err) {
          logger.error('[VECTOR_MEMORY] Erro ao reforçar memórias:', err);
        } else {
          logger.info(`[VECTOR_MEMORY] Reforçadas ${this.changes} memórias (IDs: ${ids.join(', ')})`);
        }
        resolve();
      }
    );
  });
}

/**
 * Atualiza o conteúdo, categoria e/ou importância de uma memória existente e re-gera seu embedding.
 */
export async function updateVectorMemory(
  id: number,
  content: string,
  category?: string,
  importance?: number,
  metadata?: Record<string, any>
): Promise<boolean> {
  await initVectorMemory();
  const db = getVectorDB();
  const cleanContent = content.trim();
  const now = new Date().toISOString();

  // 1. Gera o novo embedding vetorial
  const embedding = await generateEmbedding(cleanContent);
  const embeddingBuffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

  return new Promise((resolve, reject) => {
    const metaStr = metadata ? JSON.stringify(metadata) : null;
    
    // Atualiza metadados no SQLite relacional
    let sql = `UPDATE long_term_memories SET content = ?, updated_at = ?, last_accessed_at = ?`;
    const params: any[] = [cleanContent, now, now];

    if (category) {
      sql += `, category = ?`;
      params.push(category);
    }
    if (typeof importance === 'number') {
      sql += `, importance = ?`;
      params.push(Math.max(0.0, Math.min(1.0, importance)));
    }
    if (metadata) {
      sql += `, metadata = ?`;
      params.push(metaStr);
    }

    sql += ` WHERE id = ?`;
    params.push(id);

    db.run(sql, params, function (err) {
      if (err) return reject(err);
      if (this.changes === 0) return resolve(false);

      // 2. Atualiza vetor no sqlite-vec (remove e reinsere na tabela virtual)
      db.run(`DELETE FROM vec_memories WHERE rowid = ?`, [id], (delErr) => {
        if (delErr) logger.warn(`[VECTOR_MEMORY] Erro ao deletar vetor antigo id ${id}:`, delErr);
        db.run(
          `INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)`,
          [id, embeddingBuffer],
          (vecErr) => {
            if (vecErr) {
              logger.error(`[VECTOR_MEMORY] Erro ao atualizar embedding no vec_memories id ${id}:`, vecErr);
              return reject(vecErr);
            }
            logger.info(`[VECTOR_MEMORY] Memória ID ${id} atualizada com sucesso.`);
            resolve(true);
          }
        );
      });
    });
  });
}

/**
 * Remove uma memória pelo ID do banco e da tabela vetorial.
 */
export async function deleteVectorMemory(id: number): Promise<boolean> {
  await initVectorMemory();
  const db = getVectorDB();

  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM long_term_memories WHERE id = ?`, [id], function (err) {
      if (err) return reject(err);
      db.run(`DELETE FROM vec_memories WHERE rowid = ?`, [id], (vecErr) => {
        if (vecErr) logger.warn(`[VECTOR_MEMORY] Erro ao remover do vec_memories ID ${id}:`, vecErr);
        resolve(true);
      });
    });
  });
}

/**
 * Busca ampla por entidade/evento/projeto: combina busca textual (LIKE) com busca semântica
 * para retornar TODAS as memórias relacionadas a um evento (ex: "festa da Cecilia").
 * Retorna até `limit` resultados sem a restrição rígida de top-k da busca vetorial pura.
 */
export async function searchEntityMemory(
  keywords: string[],
  chatJid?: string,
  limit: number = 20,
  isTrustedChat: boolean = true
): Promise<VectorMemoryRecord[]> {
  await initVectorMemory();
  const db = getVectorDB();

  return new Promise((resolve, reject) => {
    // Build LIKE conditions for each keyword (OR logic: any keyword match counts)
    const likeConditions = keywords.map(() => `m.content LIKE ?`).join(' OR ');
    const likeParams = keywords.map(kw => `%${kw}%`);

    let sql = `
      SELECT m.id, m.content, m.category, m.chat_jid, m.importance, m.access_count, m.last_accessed_at, m.created_at, m.updated_at, m.metadata
      FROM long_term_memories m
      WHERE (${likeConditions})
    `;
    const params: any[] = [...likeParams];

    // Isolamento de sandbox apenas para chats NÃO confiáveis
    if (!isTrustedChat && chatJid && chatJid !== 'unknown') {
      sql += ` AND (m.chat_jid = ? OR m.chat_jid = 'global')`;
      params.push(chatJid);
    }

    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    params.push(limit);

    db.all(sql, params, (err, rows: any[]) => {
      if (err) {
        logger.error('[VECTOR_MEMORY] Erro na busca por entidade:', err);
        return reject(err);
      }

      const results: VectorMemoryRecord[] = (rows || []).map((r) => ({
        id: r.id,
        content: r.content,
        category: r.category,
        chatJid: r.chat_jid,
        importance: typeof r.importance === 'number' ? r.importance : 0.5,
        accessCount: r.access_count || 1,
        lastAccessedAt: r.last_accessed_at || r.created_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined
      }));

      logger.info(`[VECTOR_MEMORY] Busca por entidade [${keywords.join(', ')}]: ${results.length} resultados.`);
      resolve(results);
    });
  });
}

/**
 * Lista memórias recentes gravadas com suporte aos metadados cognitivos.
 */
export async function listVectorMemories(limit: number = 50, chatJid?: string, isTrustedChat: boolean = true): Promise<VectorMemoryRecord[]> {
  await initVectorMemory();
  const db = getVectorDB();

  return new Promise((resolve, reject) => {
    let sql = `SELECT id, content, category, chat_jid, importance, access_count, last_accessed_at, created_at, updated_at, metadata FROM long_term_memories`;
    const params: any[] = [];

    if (isTrustedChat) {
      if (chatJid && chatJid !== 'unknown' && chatJid !== 'global') {
        sql += ` WHERE (chat_jid = ? OR chat_jid = 'global')`;
        params.push(chatJid);
      } else {
        sql += ` WHERE chat_jid = 'global'`;
      }
    } else {
      if (chatJid && chatJid !== 'unknown') {
        sql += ` WHERE chat_jid = ?`;
        params.push(chatJid);
      } else {
        sql += ` WHERE chat_jid = 'untrusted_default'`;
      }
    }

    sql += ` ORDER BY id DESC LIMIT ?`;
    params.push(limit);

    db.all(sql, params, (err, rows: any[]) => {
      if (err) return reject(err);
      const results = (rows || []).map((r) => ({
        id: r.id,
        content: r.content,
        category: r.category,
        chatJid: r.chat_jid,
        importance: typeof r.importance === 'number' ? r.importance : 0.5,
        accessCount: r.access_count || 1,
        lastAccessedAt: r.last_accessed_at || r.created_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined
      }));
      resolve(results);
    });
  });
}

/**
 * Retorna as memórias vinculadas a um assunto (topicId) específico.
 */
export async function getMemoriesByTopicId(topicId: string, limit: number = 20): Promise<VectorMemoryRecord[]> {
  await initVectorMemory();
  const db = getVectorDB();

  return new Promise((resolve, reject) => {
    // Usando JSON_EXTRACT para buscar no sqlite pelo metadado
    db.all(
      `SELECT id, content, category, chat_jid, importance, access_count, last_accessed_at, created_at, updated_at, metadata
       FROM long_term_memories 
       WHERE json_extract(metadata, '$.topicId') = ? 
       ORDER BY created_at DESC LIMIT ?`,
      [topicId, limit],
      (err, rows: any[]) => {
        if (err) {
          // Fallback caso a versão do sqlite não suporte json_extract: busca tudo e filtra no JS
          logger.warn('[VECTOR_MEMORY] Erro na query JSON, tentando fallback JS', err);
          db.all(
            `SELECT id, content, category, chat_jid, importance, access_count, last_accessed_at, created_at, updated_at, metadata
             FROM long_term_memories ORDER BY created_at DESC`,
            (err2, rows2: any[]) => {
              if (err2) return reject(err2);
              const filtered = (rows2 || []).map((r) => ({
                id: r.id,
                content: r.content,
                category: r.category,
                chatJid: r.chat_jid,
                importance: typeof r.importance === 'number' ? r.importance : 0.5,
                accessCount: r.access_count || 1,
                lastAccessedAt: r.last_accessed_at || r.created_at,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                metadata: r.metadata ? JSON.parse(r.metadata) : undefined
              })).filter(m => m.metadata && m.metadata.topicId === topicId).slice(0, limit);
              resolve(filtered);
            }
          );
          return;
        }

        const results = (rows || []).map((r) => ({
          id: r.id,
          content: r.content,
          category: r.category,
          chatJid: r.chat_jid,
          importance: typeof r.importance === 'number' ? r.importance : 0.5,
          accessCount: r.access_count || 1,
          lastAccessedAt: r.last_accessed_at || r.created_at,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          metadata: r.metadata ? JSON.parse(r.metadata) : undefined
        }));
        resolve(results);
      }
    );
  });
}

/**
 * Sincroniza informações legadas em formato Markdown (data/bia_memory.md) para o banco vetorial,
 * garantindo importance = 1.0 e category = 'perfil'.
 */
export async function syncCoreMemoryToVector(): Promise<number> {
  try {
    await initVectorMemory();
    const memoryFile = path.resolve(process.cwd(), 'data', 'bia_memory.md');

    if (!fs.existsSync(memoryFile)) return 0;

    const fileContent = fs.readFileSync(memoryFile, 'utf-8');
    const lines = fileContent.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

    let importedCount = 0;
    const existing = await listVectorMemories(1000);
    const existingTexts = new Set(existing.map((e) => e.content));

    for (const line of lines) {
      // Remove marcadores markdown como - ou *
      const cleanText = line.replace(/^[-*]\s*/, '').trim();
      if (cleanText.length > 5 && !existingTexts.has(cleanText)) {
        try {
          await addVectorMemory(cleanText, 'perfil', 'global', { source: 'bia_memory.md' }, 1.0);
          importedCount++;
        } catch (e) {
          logger.warn(`[VECTOR_MEMORY] Falha ao importar item do markdown para vetor: "${cleanText}"`, e);
        }
      }
    }

    // Migração opcional de sandboxes locais para o banco vetorial
    const sandboxesDir = path.resolve(process.cwd(), 'data', 'sandboxes');
    if (fs.existsSync(sandboxesDir)) {
      const dirs = fs.readdirSync(sandboxesDir);
      for (const dir of dirs) {
        const sboxFile = path.join(sandboxesDir, dir, 'bia_memory.md');
        if (fs.existsSync(sboxFile)) {
          const sboxContent = fs.readFileSync(sboxFile, 'utf-8');
          const sboxLines = sboxContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.includes('Nenhuma anotação'));
          for (const sLine of sboxLines) {
            const cleanSLine = sLine.replace(/^[-*]\s*/, '').trim();
            if (cleanSLine.length > 5 && !existingTexts.has(cleanSLine)) {
              try {
                const targetJid = dir.replace(/_/g, '@').replace('@s@whatsapp@net', '@s.whatsapp.net');
                await addVectorMemory(cleanSLine, 'anotacao', targetJid, { source: 'sandbox_migration' }, 0.8);
                importedCount++;
              } catch (e) {}
            }
          }
        }
      }
    }

    if (importedCount > 0) {
      logger.info(`[VECTOR_MEMORY] Sincronizados ${importedCount} itens legados do Markdown para o banco vetorial cognitivo.`);
    }

    return importedCount;
  } catch (error) {
    logger.error('[VECTOR_MEMORY] Erro na sincronização de bia_memory.md para vetor:', error);
    return 0;
  }
}

/**
 * Realiza busca semântica RAG utilizando um embedding vetorial já calculado (evita recomputar na arbitragem).
 */
export async function searchVectorMemoryByEmbedding(
  queryEmbedding: Float32Array,
  limit: number = 5,
  chatJid?: string,
  isTrustedChat: boolean = true,
  maxDistance?: number
): Promise<VectorMemoryRecord[]> {
  await initVectorMemory();

  const db = getVectorDB();
  const kLimit = Math.max(200, limit * 10);

  return new Promise((resolve, reject) => {
    const sql = `
      SELECT 
        m.id, 
        m.content, 
        m.category, 
        m.chat_jid, 
        m.importance,
        m.access_count,
        m.last_accessed_at,
        m.created_at, 
        m.updated_at, 
        m.metadata, 
        v.distance
      FROM vec_memories v
      JOIN long_term_memories m ON m.id = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `;

    const queryBuffer = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);

    db.all(sql, [queryBuffer, kLimit], (err, rows: any[]) => {
      if (err) {
        logger.error('[VECTOR_MEMORY] Erro na busca por embedding pré-calculado:', err);
        return reject(err);
      }

      if (!rows || rows.length === 0) {
        return resolve([]);
      }

      let results: VectorMemoryRecord[] = rows.map((r) => ({
        id: r.id,
        content: r.content,
        category: r.category,
        chatJid: r.chat_jid,
        importance: typeof r.importance === 'number' ? r.importance : 0.5,
        accessCount: r.access_count || 1,
        lastAccessedAt: r.last_accessed_at || r.created_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        distance: r.distance
      }));

      // Filtro de distância máxima (se especificado)
      if (typeof maxDistance === 'number') {
        results = results.filter((m) => typeof m.distance === 'number' && m.distance <= maxDistance);
      }

      // Isolamento de chat não confiável
      if (!isTrustedChat && chatJid && chatJid !== 'unknown') {
        results = results.filter((m) => m.chatJid === chatJid || m.chatJid === 'global');
      }

      resolve(results.slice(0, limit));
    });
  });
}

/**
 * Remove múltiplas memórias em lote tanto da tabela relacional quanto da tabela vetorial.
 */
export async function batchDeleteVectorMemories(ids: number[]): Promise<number> {
  if (!ids || ids.length === 0) return 0;
  await initVectorMemory();
  const db = getVectorDB();
  const placeholders = ids.map(() => '?').join(',');

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`DELETE FROM long_term_memories WHERE id IN (${placeholders})`, ids, function (err) {
        if (err) {
          logger.error('[VECTOR_MEMORY] Erro ao deletar memórias em lote (long_term_memories):', err);
          return reject(err);
        }
        const changes = this.changes || 0;

        db.run(`DELETE FROM vec_memories WHERE rowid IN (${placeholders})`, ids, (vecErr) => {
          if (vecErr) {
            logger.warn('[VECTOR_MEMORY] Erro ao deletar vetores em lote (vec_memories):', vecErr);
          }
          logger.info(`[VECTOR_MEMORY] Deletadas ${changes} memórias em lote (IDs: ${ids.join(', ')})`);
          resolve(changes);
        });
      });
    });
  });
}

/**
 * Atualiza a importância de múltiplas memórias em lote.
 */
export async function batchUpdateImportance(updates: Array<{ id: number; newImportance: number }>): Promise<void> {
  if (!updates || updates.length === 0) return;
  await initVectorMemory();
  const db = getVectorDB();
  const now = new Date().toISOString();

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`UPDATE long_term_memories SET importance = ?, updated_at = ? WHERE id = ?`);
      let errorOccurred: Error | null = null;

      for (const u of updates) {
        const validImp = Math.max(0.0, Math.min(1.0, u.newImportance));
        stmt.run([validImp, now, u.id], (err: any) => {
          if (err && !errorOccurred) errorOccurred = err;
        });
      }

      stmt.finalize((finErr) => {
        if (finErr || errorOccurred) {
          logger.error('[VECTOR_MEMORY] Erro ao atualizar importância em lote:', finErr || errorOccurred);
          return reject(finErr || errorOccurred);
        }
        logger.info(`[VECTOR_MEMORY] Importância atualizada em lote para ${updates.length} memórias.`);
        resolve();
      });
    });
  });
}

/**
 * Atualiza múltiplas memórias (conteúdo + embedding) em lote.
 */
export async function batchUpdateVectorMemories(
  updates: Array<{ id: number; content: string; category?: string; importance?: number; metadata?: Record<string, any> }>
): Promise<void> {
  for (const u of updates) {
    await updateVectorMemory(u.id, u.content, u.category, u.importance, u.metadata);
  }
}

/**
 * Adiciona uma nova memória aplicando reconciliação semântica prévia caso seja uma categoria sensível.
 * Resolve contradições, atualiza fatos parciais e expurga informações superadas.
 */
export async function addVectorMemoryWithReconciliation(
  content: string,
  category: string = 'geral',
  chatJid: string = 'global',
  metadata?: Record<string, any>,
  importance: number = 0.5,
  isTrustedChat: boolean = true
): Promise<{ memoryId: number | null; verdict?: ArbiterVerdict }> {
  await initVectorMemory();

  if (!content || !content.trim()) {
    throw new Error('Conteúdo da memória não pode ser vazio.');
  }

  const cleanContent = content.trim();
  const normalizedCategory = category.toLowerCase().trim();
  const sensitiveCategories = ['perfil', 'fato', 'preferencia', 'combinado'];

  // Categorias efêmeras ou não sensíveis não passam por arbitragem
  if (!sensitiveCategories.includes(normalizedCategory)) {
    const memoryId = await addVectorMemory(cleanContent, category, chatJid, metadata, importance);
    return { memoryId };
  }

  // 1. Gera embedding do novo fato para a busca local prévia
  const embedding = await generateEmbedding(cleanContent);

  // 2. Busca candidatos próximos (distância vetorial <= 0.35)
  const candidates = await searchVectorMemoryByEmbedding(
    embedding,
    5,
    chatJid,
    isTrustedChat,
    0.35
  );

  // 3. Se não houver candidatos similares, insere direto sem custo de LLM
  if (!candidates || candidates.length === 0) {
    const memoryId = await addVectorMemory(cleanContent, category, chatJid, metadata, importance);
    return { memoryId };
  }

  // 4. Se houver candidatos, submete ao Árbitro Semântico
  logger.info(`[VECTOR_MEMORY] ${candidates.length} candidatos encontrados para arbitragem de "${cleanContent.slice(0, 40)}..."`);
  const verdict = await arbitrateMemoryCandidate(cleanContent, category, candidates);

  // 5. Executa as decisões do árbitro
  const toDeleteIds: number[] = [];

  for (const decision of verdict.decisions) {
    if (decision.action === 'DELETE') {
      toDeleteIds.push(decision.candidateId);
    } else if (decision.action === 'UPDATE') {
      const candidate = candidates.find(c => c.id === decision.candidateId);
      const newText = decision.updatedContent || candidate?.content || cleanContent;
      const newImp = decision.updatedImportance ?? candidate?.importance ?? importance;
      await updateVectorMemory(decision.candidateId, newText, candidate?.category || category, newImp);
    }
  }

  if (toDeleteIds.length > 0) {
    await batchDeleteVectorMemories(toDeleteIds);
  }

  // 6. Insere o novo fato se o árbitro autorizou
  let newMemoryId: number | null = null;
  if (verdict.shouldInsertNew !== false) {
    const finalContent = verdict.refinedContent && verdict.refinedContent.trim() ? verdict.refinedContent.trim() : cleanContent;
    newMemoryId = await addVectorMemory(finalContent, category, chatJid, metadata, importance);
  }

  return { memoryId: newMemoryId, verdict };
}

