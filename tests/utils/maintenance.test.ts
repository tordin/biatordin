import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { runSystemMaintenance, initDailyMaintenance } from '../../src/utils/maintenance.js';

describe('System Maintenance & Log Cleanup', () => {
  const testDir = path.resolve(process.cwd(), 'data/test_maintenance');
  const testDbPath = path.join(testDir, 'test_db.sqlite');
  const testLogPath = path.join(testDir, 'test_detailed.jsonl');

  beforeAll(async () => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('deve filtrar linhas antigas do JSONL e preservar as recentes', async () => {
    const now = new Date();
    const oldDate = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000); // 20 dias atrás
    const recentDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 dias atrás

    const lines = [
      JSON.stringify({ timestamp: oldDate.toISOString(), event: 'OLD_EVENT', data: {} }),
      JSON.stringify({ timestamp: recentDate.toISOString(), event: 'RECENT_EVENT', data: {} }),
      JSON.stringify({ timestamp: now.toISOString(), event: 'NOW_EVENT', data: {} })
    ];

    fs.writeFileSync(testLogPath, lines.join('\n') + '\n', 'utf-8');

    // Inicializa DB vazio de teste
    const db = new sqlite3.Database(testDbPath);
    await new Promise<void>((resolve) => {
      db.serialize(() => {
        db.run(`
          CREATE TABLE checkpoints (
            thread_id TEXT,
            checkpoint_ns TEXT DEFAULT '',
            checkpoint_id TEXT,
            checkpoint BLOB,
            PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
          )
        `);
        db.run(`
          CREATE TABLE writes (
            thread_id TEXT,
            checkpoint_ns TEXT DEFAULT '',
            checkpoint_id TEXT,
            task_id TEXT,
            idx INTEGER,
            channel TEXT,
            PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
          )
        `);
        db.run(`
          CREATE TABLE email_sentinel_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            emailId TEXT NOT NULL UNIQUE,
            processedAt DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, () => {
          db.close(() => resolve());
        });
      });
    });

    const report = await runSystemMaintenance({
      retentionDays: 14,
      dbPath: testDbPath,
      logFilePath: testLogPath,
      vacuum: true
    });

    expect(report.jsonlTotalLines).toBe(3);
    expect(report.jsonlKeptLines).toBe(2);

    const filteredContent = fs.readFileSync(testLogPath, 'utf-8');
    expect(filteredContent).not.toContain('OLD_EVENT');
    expect(filteredContent).toContain('RECENT_EVENT');
    expect(filteredContent).toContain('NOW_EVENT');
  });

  test('deve limpar checkpoints antigos mas preservar o mais recente de cada thread', async () => {
    const db = new sqlite3.Database(testDbPath);

    const oldTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const midTimestamp = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString();
    const recentTimestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    await new Promise<void>((resolve) => {
      db.serialize(() => {
        // Thread 1: tem checkpoint antigo intermediário e checkpoint recente
        db.run("INSERT INTO checkpoints VALUES ('thread1', '', 'ckpt1_old', ?)", [
          JSON.stringify({ ts: oldTimestamp })
        ]);
        db.run("INSERT INTO checkpoints VALUES ('thread1', '', 'ckpt1_recent', ?)", [
          JSON.stringify({ ts: recentTimestamp })
        ]);

        // Thread 2: inativa há 30 dias, mas ckpt2_mid é o ÚLTIMO dela (deve ser preservado!)
        db.run("INSERT INTO checkpoints VALUES ('thread2', '', 'ckpt2_old', ?)", [
          JSON.stringify({ ts: oldTimestamp })
        ]);
        db.run("INSERT INTO checkpoints VALUES ('thread2', '', 'ckpt2_mid', ?)", [
          JSON.stringify({ ts: midTimestamp })
        ]);

        // Writes correspondentes
        db.run("INSERT INTO writes VALUES ('thread1', '', 'ckpt1_old', 'task1', 0, 'messages')");
        db.run("INSERT INTO writes VALUES ('thread1', '', 'ckpt1_recent', 'task1', 0, 'messages')");
        db.run("INSERT INTO writes VALUES ('thread2', '', 'ckpt2_old', 'task1', 0, 'messages')");
        db.run("INSERT INTO writes VALUES ('thread2', '', 'ckpt2_mid', 'task1', 0, 'messages')", () => {
          db.close(() => resolve());
        });
      });
    });

    const report = await runSystemMaintenance({
      retentionDays: 14,
      dbPath: testDbPath,
      logFilePath: testLogPath,
      vacuum: false
    });

    expect(report.dbCheckpointsRemoved).toBe(2); // ckpt1_old e ckpt2_old removidos
    expect(report.dbWritesRemoved).toBe(2);

    const checkDb = new sqlite3.Database(testDbPath);
    const remainingCheckpoints = await new Promise<any[]>((resolve) => {
      checkDb.all("SELECT thread_id, checkpoint_id FROM checkpoints ORDER BY thread_id, checkpoint_id", (err, rows) => {
        checkDb.close(() => resolve(rows));
      });
    });

    expect(remainingCheckpoints).toEqual([
      { thread_id: 'thread1', checkpoint_id: 'ckpt1_recent' },
      { thread_id: 'thread2', checkpoint_id: 'ckpt2_mid' }
    ]);
  });

  test('deve agendar rotina diária com initDailyMaintenance sem lançar exceção', () => {
    expect(() => initDailyMaintenance('0 3 * * *', 14)).not.toThrow();
  });
});
