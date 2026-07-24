/**
 * Script para re-gerar os embeddings vetoriais das memórias que foram
 * re-contextualizadas (IDs 91-100, 110-112).
 * 
 * Execução: npx tsx tools/reembed-memories.ts
 */
import sqlite3 from 'sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = './database.sqlite';
const IDS_TO_REEMBED = [91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 110, 111, 112];

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function generateEmbedding(text: string): Promise<Float32Array> {
  const response = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: text.trim()
  });
  const values = response?.embeddings?.[0]?.values;
  if (!values || !Array.isArray(values) || values.length === 0) {
    throw new Error('Formato de resposta inválido da API de embedding.');
  }
  return new Float32Array(values);
}

async function main() {
  const db = new sqlite3.Database(DB_PATH);
  sqliteVec.load(db as any);

  for (const id of IDS_TO_REEMBED) {
    const row: any = await new Promise((resolve, reject) => {
      db.get('SELECT id, content FROM long_term_memories WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!row) {
      console.log(`ID ${id}: not found, skipping.`);
      continue;
    }

    console.log(`ID ${id}: Re-embedding "${row.content.substring(0, 80)}..."`);

    const embedding = await generateEmbedding(row.content);
    const embeddingBuffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    // Delete old vector
    await new Promise<void>((resolve, reject) => {
      db.run('DELETE FROM vec_memories WHERE rowid = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Insert new vector
    await new Promise<void>((resolve, reject) => {
      db.run('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)', [id, embeddingBuffer], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log(`ID ${id}: ✅ Re-embedded successfully.`);

    // Rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  db.close();
  console.log('\n🎉 All orphaned memories re-embedded with event context!');
}

main().catch(console.error);
