import fs from 'fs';
import path from 'path';
import readline from 'readline';
import sqlite3 from 'sqlite3';
import cron from 'node-cron';
import { logger } from './logger.js';
import { getDbPath } from '../memory/db.js';

export interface MaintenanceOptions {
  retentionDays?: number;
  vacuum?: boolean;
  dbPath?: string;
  logFilePath?: string;
}

export interface MaintenanceReport {
  jsonlInitialBytes: number;
  jsonlFinalBytes: number;
  jsonlTotalLines: number;
  jsonlKeptLines: number;
  dbInitialBytes: number;
  dbFinalBytes: number;
  dbCheckpointsRemoved: number;
  dbWritesRemoved: number;
  durationMs: number;
}

const DEFAULT_RETENTION_DAYS = 14;

/**
 * Remove arquivos temporários ou legados conhecidos que não são mais utilizados
 */
function cleanupKnownScrapFiles() {
  const scrapFiles = [
    path.resolve(process.cwd(), 'data/bia_detailed.jsonl.bak'),
    path.resolve(process.cwd(), 'data/bia_tail.jsonl'),
    path.resolve(process.cwd(), 'data/scratch.jsonl'),
    path.resolve(process.cwd(), 'data/scratch_thread.jsonl'),
    path.resolve(process.cwd(), 'data/thread.jsonl'),
    path.resolve(process.cwd(), 'data/trigger.jsonl'),
    path.resolve(process.cwd(), 'recent_message.jsonl'),
    path.resolve(process.cwd(), 'recent_messages.jsonl'),
    path.resolve(process.cwd(), 'recent_msgs.jsonl'),
    path.resolve(process.cwd(), 'thread_dump.jsonl'),
    path.resolve(process.cwd(), '1697B337_logs.jsonl')
  ];

  for (const file of scrapFiles) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        logger.warn(`[MAINTENANCE] Não foi possível remover arquivo scrap ${file}:`, err);
      }
    }
  }
}

/**
 * Filtra o arquivo bia_detailed.jsonl mantendo apenas os últimos N dias
 */
async function cleanDetailedJsonl(logFilePath: string, cutoffDate: Date): Promise<{ initialBytes: number; finalBytes: number; totalLines: number; keptLines: number }> {
  if (!fs.existsSync(logFilePath)) {
    return { initialBytes: 0, finalBytes: 0, totalLines: 0, keptLines: 0 };
  }

  const initialBytes = fs.statSync(logFilePath).size;
  const tempPath = `${logFilePath}.tmp`;

  const readStream = fs.createReadStream(logFilePath, { encoding: 'utf-8' });
  const writeStream = fs.createWriteStream(tempPath, { encoding: 'utf-8' });

  const rl = readline.createInterface({
    input: readStream,
    crlfDelay: Infinity
  });

  let totalLines = 0;
  let keptLines = 0;

  for await (const line of rl) {
    totalLines++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.timestamp) {
        const itemDate = new Date(parsed.timestamp);
        if (itemDate >= cutoffDate) {
          writeStream.write(trimmed + '\n');
          keptLines++;
        }
      } else {
        // Se não tiver timestamp, mantém por segurança
        writeStream.write(trimmed + '\n');
        keptLines++;
      }
    } catch {
      // Linha corrompida, descarta
    }
  }

  writeStream.end();

  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  // Substitui arquivo de forma atômica
  fs.renameSync(tempPath, logFilePath);

  const finalBytes = fs.statSync(logFilePath).size;

  return { initialBytes, finalBytes, totalLines, keptLines };
}

/**
 * Executa a limpeza de checkpoints antigos e writes no SQLite, preservando o último de cada thread
 */
async function cleanSqliteDatabase(
  dbPath: string,
  cutoffIso: string,
  vacuum: boolean
): Promise<{ initialBytes: number; finalBytes: number; checkpointsRemoved: number; writesRemoved: number }> {
  if (!fs.existsSync(dbPath)) {
    return { initialBytes: 0, finalBytes: 0, checkpointsRemoved: 0, writesRemoved: 0 };
  }

  const initialBytes = fs.statSync(dbPath).size;

  const db = new sqlite3.Database(dbPath);

  const runQuery = (sql: string, params: any[] = []): Promise<{ changes: number }> => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
        if (err) return reject(err);
        resolve({ changes: this.changes });
      });
    });
  };

  const execQuery = (sql: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      db.exec(sql, (err: Error | null) => {
        if (err) return reject(err);
        resolve();
      });
    });
  };

  let checkpointsRemoved = 0;
  let writesRemoved = 0;

  try {
    // 1. Remove checkpoints com mais de N dias que NÃO sejam o checkpoint mais recente de cada thread
    const deleteCkptResult = await runQuery(`
      DELETE FROM checkpoints
      WHERE json_extract(CAST(checkpoint AS TEXT), '$.ts') < ?
        AND (thread_id, checkpoint_id) NOT IN (
          SELECT thread_id, checkpoint_id FROM (
            SELECT thread_id, checkpoint_id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY rowid DESC) as rn
            FROM checkpoints
          ) WHERE rn = 1
        )
    `, [cutoffIso]);
    checkpointsRemoved = deleteCkptResult.changes;

    // 2. Remove gravações em 'writes' cujos checkpoints não existem mais
    const deleteWritesResult = await runQuery(`
      DELETE FROM writes
      WHERE checkpoint_id NOT IN (SELECT checkpoint_id FROM checkpoints)
    `);
    writesRemoved = deleteWritesResult.changes;

    // 3. Remove logs do Sentinela de E-mail com mais de 30 dias (manter janela maior para desduplicação)
    await runQuery(`
      DELETE FROM email_sentinel_log
      WHERE processedAt < datetime('now', '-30 days')
    `);

    // 4. Executa VACUUM para devolver o espaço em disco
    if (vacuum) {
      await execQuery("VACUUM;");
    }

    // 5. Esvazia e trunca o arquivo WAL para sincronizar completamente com o disco
    await execQuery("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    await new Promise<void>((resolve) => db.close(() => resolve()));
  }

  const finalBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

  return { initialBytes, finalBytes, checkpointsRemoved, writesRemoved };
}

/**
 * Função principal de manutenção do sistema
 */
export async function runSystemMaintenance(options: MaintenanceOptions = {}): Promise<MaintenanceReport> {
  const startTime = Date.now();
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const vacuum = options.vacuum ?? true;
  const dbPath = options.dbPath || getDbPath();
  const logFilePath = options.logFilePath || path.resolve(process.cwd(), 'data/bia_detailed.jsonl');

  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoffDate.toISOString();

  logger.info(`[MAINTENANCE] Iniciando higienização do sistema (Janela retroativa: ${retentionDays} dias / Corte: ${cutoffIso})...`);

  // 1. Limpeza de arquivos residuais
  cleanupKnownScrapFiles();

  // 2. Higienização do bia_detailed.jsonl
  const jsonlResult = await cleanDetailedJsonl(logFilePath, cutoffDate);

  // 3. Higienização do SQLite
  const dbResult = await cleanSqliteDatabase(dbPath, cutoffIso, vacuum);

  const durationMs = Date.now() - startTime;

  const report: MaintenanceReport = {
    jsonlInitialBytes: jsonlResult.initialBytes,
    jsonlFinalBytes: jsonlResult.finalBytes,
    jsonlTotalLines: jsonlResult.totalLines,
    jsonlKeptLines: jsonlResult.keptLines,
    dbInitialBytes: dbResult.initialBytes,
    dbFinalBytes: dbResult.finalBytes,
    dbCheckpointsRemoved: dbResult.checkpointsRemoved,
    dbWritesRemoved: dbResult.writesRemoved,
    durationMs
  };

  const jsonlSavedMB = ((jsonlResult.initialBytes - jsonlResult.finalBytes) / (1024 * 1024)).toFixed(2);
  const dbSavedMB = ((dbResult.initialBytes - dbResult.finalBytes) / (1024 * 1024)).toFixed(2);
  const dbFinalMB = (dbResult.finalBytes / (1024 * 1024)).toFixed(2);

  logger.info(
    `[MAINTENANCE] Concluída em ${durationMs}ms! ` +
    `JSONL: -${jsonlSavedMB} MB (${jsonlResult.keptLines}/${jsonlResult.totalLines} linhas). ` +
    `SQLite: -${dbSavedMB} MB (removidos ${dbResult.checkpointsRemoved} checkpoints e ${dbResult.writesRemoved} writes | tamanho final: ${dbFinalMB} MB).`
  );

  return report;
}

let maintenanceJob: ReturnType<typeof cron.schedule> | null = null;

/**
 * Agenda a manutenção diária automática (Padrão: 03:00 da manhã)
 */
export function initDailyMaintenance(cronExpression: string = '0 3 * * *', retentionDays: number = DEFAULT_RETENTION_DAYS) {
  if (maintenanceJob) {
    maintenanceJob.stop();
  }

  logger.info(`[MAINTENANCE] Agendando higienização diária automática (Expressão: "${cronExpression}", Retenção: ${retentionDays} dias).`);

  maintenanceJob = cron.schedule(cronExpression, async () => {
    try {
      await runSystemMaintenance({ retentionDays, vacuum: true });
    } catch (err) {
      logger.error("[MAINTENANCE] Erro durante execução da manutenção diária agendada:", err);
    }
  });
}
