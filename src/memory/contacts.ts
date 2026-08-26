import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';

export interface ContactRecord {
  jid: string;       // Canonical JID
  name: string;      // User-defined name or alias (e.g., "Minha Mãe")
  pushName: string;  // WhatsApp Profile Name
  updatedAt: number;
}

const db = new sqlite3.Database('database.sqlite', (err) => {
    if (err) {
        logger.error("[CONTACTS DB] Erro ao conectar no SQLite:", err);
    }
});

db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        pushName TEXT,
        updatedAt INTEGER
      )
    `);
});

export function saveContact(jid: string, name: string, pushName: string = ''): Promise<void> {
  return new Promise((resolve, reject) => {
      const now = Date.now();
      db.get(`SELECT * FROM contacts WHERE jid = ?`, [jid], (err, row: any) => {
          if (err) return reject(err);
          if (row) {
              db.run(`UPDATE contacts SET name = ?, pushName = ?, updatedAt = ? WHERE jid = ?`,
                  [name || row.name, pushName || row.pushName, now, jid],
                  (err) => err ? reject(err) : resolve()
              );
          } else {
              db.run(`INSERT INTO contacts (jid, name, pushName, updatedAt) VALUES (?, ?, ?, ?)`,
                  [jid, name, pushName, now],
                  (err) => err ? reject(err) : resolve()
              );
          }
      });
  });
}

export function updateContactPushName(jid: string, pushName: string): Promise<void> {
  return new Promise((resolve, reject) => {
      if (!pushName) return resolve();
      const now = Date.now();
      db.get(`SELECT * FROM contacts WHERE jid = ?`, [jid], (err, row: any) => {
          if (err) return reject(err);
          if (row) {
              if (row.pushName !== pushName) {
                  db.run(`UPDATE contacts SET pushName = ?, updatedAt = ? WHERE jid = ?`, [pushName, now, jid], (err) => err ? reject(err) : resolve());
              } else {
                  resolve();
              }
          } else {
              db.run(`INSERT INTO contacts (jid, name, pushName, updatedAt) VALUES (?, ?, ?, ?)`,
                  [jid, '', pushName, now],
                  (err) => err ? reject(err) : resolve()
              );
          }
      });
  });
}

export function getContact(jid: string): Promise<ContactRecord | undefined> {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM contacts WHERE jid = ?`, [jid], (err, row: any) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

export function searchContactsByName(name: string): Promise<ContactRecord[]> {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM contacts WHERE name LIKE ? OR pushName LIKE ?`, [`%${name}%`, `%${name}%`], (err, rows: any[]) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

/**
 * Busca contatos unificando a tabela contacts com o CRM de Entidades (entities).
 */
export async function searchContactsWithEntities(query: string): Promise<ContactRecord[]> {
    const rawContacts = await searchContactsByName(query);
    const seenJids = new Set(rawContacts.map(c => c.jid));
    const merged: ContactRecord[] = [...rawContacts];

    try {
        const { searchEntities } = await import('./entities.js');
        const entities = await searchEntities(query, 'person');

        for (const ent of entities) {
            const jid = ent.contact_jid || (ent.phone ? `${ent.phone}@s.whatsapp.net` : null);
            if (jid && !seenJids.has(jid)) {
                seenJids.add(jid);
                merged.push({
                    jid,
                    name: `${ent.name}${ent.role_or_relation ? ` (${ent.role_or_relation})` : ''}`,
                    pushName: ent.name,
                    updatedAt: new Date(ent.updated_at).getTime() || Date.now()
                });
            }
        }
    } catch (err) {
        logger.debug("[CONTACTS] Erro ao complementar contatos com entidades:", err);
    }

    return merged;
}

