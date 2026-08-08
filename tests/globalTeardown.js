import sqlite3 from 'sqlite3';

export default async function globalTeardown() {
  const db = new sqlite3.Database('database.sqlite');

  const safeRun = (sql) => new Promise((resolve) => {
    db.run(sql, () => resolve());
  });

  await safeRun("DELETE FROM routines WHERE chatJid LIKE 'test-%'");
  await safeRun("DELETE FROM tasks WHERE chatJid LIKE 'test-%'");
  await safeRun("DELETE FROM topics WHERE chatJid LIKE 'test-%'");
  await safeRun("DELETE FROM vec_memories WHERE rowid IN (SELECT id FROM memories WHERE chatJid LIKE 'test-%')");
  await safeRun("DELETE FROM memories WHERE chatJid LIKE 'test-%'");

  await new Promise((resolve) => db.close(resolve));
}
