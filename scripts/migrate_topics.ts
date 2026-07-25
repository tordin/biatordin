import sqlite3 from 'sqlite3';
import { logger } from '../src/utils/logger.js';
import { modelFlashStructured as model } from '../src/llm/model.js';
import { getOrCreateTopicByTitle } from '../src/memory/topics.js';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const db = new sqlite3.Database('database.sqlite');

async function ensureTopicColumns() {
  return new Promise<void>((resolve, reject) => {
    db.serialize(() => {
      // Garante que tasks tem topicId
      db.all("PRAGMA table_info(tasks)", (err, rows: any[]) => {
        if (err) return reject(err);
        if (rows && !rows.some(r => r.name === 'topicId')) {
          db.run("ALTER TABLE tasks ADD COLUMN topicId TEXT");
          logger.info("Adicionada coluna topicId em tasks.");
        }
      });
      // Garante que routines tem topicId
      db.all("PRAGMA table_info(routines)", (err, rows: any[]) => {
        if (err) return reject(err);
        if (rows && !rows.some(r => r.name === 'topicId')) {
          db.run("ALTER TABLE routines ADD COLUMN topicId TEXT");
          logger.info("Adicionada coluna topicId em routines.");
        }
      });
    });
    // Aguarda 1 segundo para o sqlite aplicar
    setTimeout(resolve, 1000);
  });
}

async function getItemsToMigrate() {
  return new Promise<{ tasks: any[], routines: any[], memories: any[] }>((resolve, reject) => {
    db.serialize(() => {
      let tasks: any[] = [];
      let routines: any[] = [];
      let memories: any[] = [];
      
      db.all(`SELECT * FROM tasks WHERE topicId IS NULL OR topicId = ''`, (err, rows) => {
        if (err) return reject(err);
        tasks = rows;
        
        db.all(`SELECT * FROM routines WHERE topicId IS NULL OR topicId = ''`, (err, rows) => {
          if (err) return reject(err);
          routines = rows;
          
          db.all(`SELECT * FROM long_term_memories WHERE json_extract(metadata, '$.topicId') IS NULL`, (err, rows) => {
            if (err) {
              // Fallback se json_extract falhar
              db.all(`SELECT * FROM long_term_memories`, (err2, allRows) => {
                if (err2) return reject(err2);
                memories = allRows.filter((r: any) => {
                  try {
                    const m = r.metadata ? JSON.parse(r.metadata) : {};
                    return !m.topicId;
                  } catch {
                    return true;
                  }
                });
                resolve({ tasks, routines, memories });
              });
            } else {
              memories = rows;
              resolve({ tasks, routines, memories });
            }
          });
        });
      });
    });
  });
}

const classifierModel = model.withStructuredOutput(z.object({
  topicTitle: z.string().describe("Título curto do assunto (ex: 'Festa da Cecília', 'Reforma do Banheiro', 'Trabalho'). Retorne 'Geral' se não couber em nenhum.")
}), { name: "TopicClassifier" });

async function migrateItem(type: 'task'|'routine'|'memory', item: any) {
  let contentToAnalyze = "";
  let chatJid = item.chatJid || item.chat_jid || 'global';
  
  if (type === 'task') contentToAnalyze = `Tarefa: ${item.title} (Categoria: ${item.category})`;
  else if (type === 'routine') contentToAnalyze = `Lembrete/Rotina: ${item.prompt}`;
  else if (type === 'memory') contentToAnalyze = `Fato/Memória: ${item.content}`;

  logger.info(`Analisando ${type}: ${contentToAnalyze}`);
  
  try {
    const parsed = await classifierModel.invoke([
      { role: "system", content: "Você é um assistente que organiza dados (tarefas, rotinas, memórias) em assuntos/tópicos curtos (ex: 'Festa da Cecília', 'Compras de Casa', 'Trabalho'). Analise o item e sugira um título de assunto para ele." },
      { role: "user", content: contentToAnalyze }
    ]);
    
    if (parsed.topicTitle && parsed.topicTitle !== 'Geral') {
      const topic = await getOrCreateTopicByTitle(chatJid, parsed.topicTitle);
      
      return new Promise<void>((resolve, reject) => {
        if (type === 'task') {
          db.run(`UPDATE tasks SET topicId = ? WHERE id = ?`, [topic.id, item.id], (err) => err ? reject(err) : resolve());
        } else if (type === 'routine') {
          db.run(`UPDATE routines SET topicId = ? WHERE id = ?`, [topic.id, item.id], (err) => err ? reject(err) : resolve());
        } else if (type === 'memory') {
          let metadata = item.metadata ? JSON.parse(item.metadata) : {};
          metadata.topicId = topic.id;
          db.run(`UPDATE long_term_memories SET metadata = ? WHERE id = ?`, [JSON.stringify(metadata), item.id], (err) => err ? reject(err) : resolve());
        }
      });
    }
  } catch (err) {
    logger.error(`Erro ao migrar item ${type} ID ${item.id}:`, err);
  }
}

async function run() {
  logger.info("Iniciando migração de tópicos...");
  await ensureTopicColumns();
  const { tasks, routines, memories } = await getItemsToMigrate();
  
  logger.info(`Encontrados: ${tasks.length} tarefas, ${routines.length} rotinas, ${memories.length} memórias para migrar.`);
  
  for (const t of tasks) {
    await migrateItem('task', t);
  }
  for (const r of routines) {
    await migrateItem('routine', r);
  }
  for (const m of memories) {
    await migrateItem('memory', m);
  }
  
  logger.info("Migração concluída com sucesso!");
}

run();
