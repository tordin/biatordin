import sqlite3 from 'sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { generateEmbedding } from './embeddings.js';

const DB_PATH = path.resolve(process.cwd(), 'database.sqlite');

let dbInstance: sqlite3.Database | null = null;
let isInitialized = false;

export interface VectorMemoryRecord {
  id: number;
  content: string;
  category: string;
  chatJid: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
  distance?: number;
}

export function getVectorDB(): sqlite3.Database {
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        logger.error('[VECTOR_MEMORY] Erro ao abrir database.sqlite:', err);
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
      // 1. Tabela de metadados das memórias
      db.run(`
        CREATE TABLE IF NOT EXISTS long_term_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT DEFAULT 'geral',
          chat_jid TEXT DEFAULT 'global',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          metadata TEXT
        )
      `, (err) => {
        if (err) {
          logger.error('[VECTOR_MEMORY] Erro ao criar tabela long_term_memories:', err);
          return reject(err);
        }
      });

      // Check se vec_memories existe com schema antigo de 768 dimensões e recria
      db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_memories'", (err, row: any) => {
        if (row && row.sql && row.sql.includes("768")) {
          logger.info("[VECTOR_MEMORY] Tabela vec_memories com 768 dims detectada. Atualizando esquema para 3072 dims...");
          db.run("DROP TABLE vec_memories");
        }

        // 2. Tabela virtual de vetores do sqlite-vec (3072 dimensões para gemini-embedding-001)
        db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
            embedding float[3072]
          )
        `, (err) => {
          if (err) {
            logger.error('[VECTOR_MEMORY] Erro ao criar tabela virtual vec_memories:', err);
            return reject(err);
          }
          isInitialized = true;
          logger.info('[VECTOR_MEMORY] Tabelas RAG inicializadas com sucesso.');
          resolve();
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
  metadata?: Record<string, any>
): Promise<number> {
  await initVectorMemory();

  if (!content || !content.trim()) {
    throw new Error('Conteúdo da memória não pode ser vazio.');
  }

  const cleanContent = content.trim();
  const now = new Date().toISOString();
  const metaStr = metadata ? JSON.stringify(metadata) : null;

  // 1. Gera o embedding vetorial do texto (3072 dims)
  const embedding = await generateEmbedding(cleanContent);

  const db = getVectorDB();

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO long_term_memories (content, category, chat_jid, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [cleanContent, category, chatJid, now, now, metaStr],
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
            logger.info(`[VECTOR_MEMORY] Nova memória salva (ID: ${memoryId}, Categoria: ${category}, Chat: ${chatJid})`);
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
  const kLimit = limit * 2;

  return new Promise((resolve, reject) => {
    // Consulta vetorial sqlite-vec exigindo "WHERE embedding MATCH ? AND k = ?"
    const sql = `
      SELECT 
        m.id, 
        m.content, 
        m.category, 
        m.chat_jid, 
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
      SELECT m.id, m.content, m.category, m.chat_jid, m.created_at, m.updated_at, m.metadata
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
 * Lista memórias recentes gravadas.
 */
export async function listVectorMemories(limit: number = 50): Promise<VectorMemoryRecord[]> {
  await initVectorMemory();
  const db = getVectorDB();

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, content, category, chat_jid, created_at, updated_at, metadata
       FROM long_term_memories ORDER BY id DESC LIMIT ?`,
      [limit],
      (err, rows: any[]) => {
        if (err) return reject(err);
        const results = (rows || []).map((r) => ({
          id: r.id,
          content: r.content,
          category: r.category,
          chatJid: r.chat_jid,
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
 * Sincroniza informações legadas em formato Markdown (data/bia_memory.md) para o banco vetorial.
 */
export async function syncCoreMemoryToVector(): Promise<number> {
  try {
    await initVectorMemory();
    const memoryFile = path.resolve(process.cwd(), 'data', 'bia_memory.md');

    if (!fs.existsSync(memoryFile)) return 0;

    const fileContent = fs.readFileSync(memoryFile, 'utf-8');
    const lines = fileContent.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

    let importedCount = 0;
    const existing = await listVectorMemories(500);
    const existingTexts = new Set(existing.map((e) => e.content));

    for (const line of lines) {
      // Remove marcadores markdown como - ou *
      const cleanText = line.replace(/^[-*]\s*/, '').trim();
      if (cleanText.length > 5 && !existingTexts.has(cleanText)) {
        try {
          await addVectorMemory(cleanText, 'perfil_legado', 'global', { source: 'bia_memory.md' });
          importedCount++;
        } catch (e) {
          logger.warn(`[VECTOR_MEMORY] Falha ao importar item do markdown para vetor: "${cleanText}"`, e);
        }
      }
    }

    if (importedCount > 0) {
      logger.info(`[VECTOR_MEMORY] Sincronizados ${importedCount} itens legados do bia_memory.md para o vetor.`);
    }

    return importedCount;
  } catch (error) {
    logger.error('[VECTOR_MEMORY] Erro na sincronização de bia_memory.md para vetor:', error);
    return 0;
  }
}
