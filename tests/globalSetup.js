import fs from 'fs';
import path from 'path';

export default async function globalSetup() {
  const testDb = 'database.test.sqlite';
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = path.resolve(process.cwd(), testDb + suffix);
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // ignora
      }
    }
  }
}
