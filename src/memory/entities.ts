import sqlite3 from 'sqlite3';
import { logger } from '../utils/logger.js';
import { getEquivalentJids } from '../utils/jidResolver.js';

const db = new sqlite3.Database('database.sqlite', (err) => {
  if (err) {
    logger.error("[ENTITIES DB] Erro ao conectar no SQLite:", err);
  }
});

export type EntityType = 'person' | 'organization' | 'project' | 'place';

export interface Entity {
  id: number;
  type: EntityType;
  name: string;
  aliases: string[];
  contact_jid: string | null;
  phone: string | null;
  email: string | null;
  role_or_relation: string | null;
  preferences: Record<string, any>;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntityRelationship {
  id: number;
  source_entity_id: number;
  target_entity_id: number;
  relation_type: string;
  context_notes: string | null;
  created_at: string;
  updated_at: string;
  source_entity?: Entity;
  target_entity?: Entity;
}

export interface CreateEntityDTO {
  id?: number;
  type?: EntityType;
  name: string;
  aliases?: string[];
  contact_jid?: string | null;
  phone?: string | null;
  email?: string | null;
  role_or_relation?: string | null;
  preferences?: Record<string, any> | string | null;
  notes?: string | null;
}

export interface UpdateEntityDTO {
  type?: EntityType;
  name?: string;
  aliases?: string[];
  contact_jid?: string | null;
  phone?: string | null;
  email?: string | null;
  role_or_relation?: string | null;
  preferences?: Record<string, any> | string | null;
  notes?: string | null;
}

export interface CreateRelationshipDTO {
  source_entity_id: number;
  target_entity_id: number;
  relation_type: string;
  context_notes?: string | null;
}

function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  let clean = phone.replace(/\D/g, '');
  if (!clean) return null;
  if (!clean.startsWith('55') && clean.length <= 11) {
    clean = '55' + clean;
  }
  return clean;
}

function parseJsonArray(val: any): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(val: any): Record<string, any> {
  if (!val) return {};
  if (typeof val === 'object' && !Array.isArray(val)) return val;
  try {
    const parsed = JSON.parse(val);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapRowToEntity(row: any): Entity {
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    aliases: parseJsonArray(row.aliases),
    contact_jid: row.contact_jid || null,
    phone: row.phone || null,
    email: row.email || null,
    role_or_relation: row.role_or_relation || null,
    preferences: parseJsonObject(row.preferences),
    notes: row.notes || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function initEntitiesTable(): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS entities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL DEFAULT 'person',
          name TEXT NOT NULL,
          aliases TEXT,
          contact_jid TEXT,
          phone TEXT,
          email TEXT,
          role_or_relation TEXT,
          preferences TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          logger.error("[ENTITIES DB] Erro ao criar tabela entities:", err);
          return reject(err);
        }
      });

      db.run(`
        CREATE TABLE IF NOT EXISTS entity_relationships (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL,
          context_notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          logger.error("[ENTITIES DB] Erro ao criar tabela entity_relationships:", err);
          return reject(err);
        }
      });

      // Indexes for high performance queries
      db.run(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_entities_phone ON entities(phone)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_entities_contact_jid ON entities(contact_jid)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_relationships_source ON entity_relationships(source_entity_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_relationships_target ON entity_relationships(target_entity_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_relationships_type ON entity_relationships(relation_type)`, () => {
        resolve();
      });
    });
  });
}

// Auto-run table initialization on module load
initEntitiesTable().catch(err => {
  logger.error("[ENTITIES DB] Falha na inicialização das tabelas de entidades:", err);
});

export async function saveEntity(dto: CreateEntityDTO): Promise<Entity> {
  const normPhone = normalizePhone(dto.phone);
  const type = dto.type || 'person';

  // 1. If explicit ID provided, update that entity
  if (dto.id) {
    const existing = await getEntityById(dto.id);
    if (existing) {
      const mergedAliases = Array.from(new Set([...existing.aliases, ...(dto.aliases || [])]));
      const mergedPreferences = { ...existing.preferences, ...parseJsonObject(dto.preferences) };
      await updateEntity(dto.id, {
        type: dto.type || existing.type,
        name: dto.name || existing.name,
        aliases: mergedAliases,
        contact_jid: dto.contact_jid !== undefined ? dto.contact_jid : existing.contact_jid,
        phone: normPhone !== null ? normPhone : existing.phone,
        email: dto.email !== undefined ? dto.email : existing.email,
        role_or_relation: dto.role_or_relation !== undefined ? dto.role_or_relation : existing.role_or_relation,
        preferences: mergedPreferences,
        notes: dto.notes !== undefined ? (existing.notes && dto.notes && !existing.notes.includes(dto.notes) ? `${existing.notes}\n${dto.notes}` : dto.notes || existing.notes) : existing.notes
      });
      const updated = await getEntityById(dto.id);
      return updated!;
    }
  }

  // 2. Check if an entity already exists with the same name, phone or JID to perform intelligent upsert
  let existingEntity: Entity | null = null;
  if (dto.name) {
    existingEntity = await getEntityByNameOrAlias(dto.name);
  }
  if (!existingEntity && normPhone) {
    existingEntity = await getEntityByPhone(normPhone);
  }
  if (!existingEntity && dto.contact_jid) {
    existingEntity = await getEntityByJid(dto.contact_jid);
  }

  if (existingEntity) {
    const incomingAliases = dto.aliases || [];
    const mergedAliases = Array.from(new Set([...existingEntity.aliases, ...incomingAliases]));
    const mergedPreferences = { ...existingEntity.preferences, ...parseJsonObject(dto.preferences) };

    const updates: UpdateEntityDTO = {
      type: dto.type || existingEntity.type,
      name: dto.name || existingEntity.name,
      aliases: mergedAliases,
      contact_jid: dto.contact_jid || existingEntity.contact_jid,
      phone: normPhone || existingEntity.phone,
      email: dto.email || existingEntity.email,
      role_or_relation: dto.role_or_relation || existingEntity.role_or_relation,
      preferences: mergedPreferences,
      notes: dto.notes ? (existingEntity.notes && !existingEntity.notes.includes(dto.notes) ? `${existingEntity.notes}\n${dto.notes}` : dto.notes) : existingEntity.notes,
    };

    await updateEntity(existingEntity.id, updates);
    const updated = await getEntityById(existingEntity.id);
    return updated!;
  }

  // 3. Insert new entity
  return new Promise((resolve, reject) => {
    const aliasesJson = JSON.stringify(dto.aliases || []);
    const preferencesJson = JSON.stringify(parseJsonObject(dto.preferences));

    const sql = `
      INSERT INTO entities (
        type, name, aliases, contact_jid, phone, email,
        role_or_relation, preferences, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    const params = [
      type,
      dto.name,
      aliasesJson,
      dto.contact_jid || null,
      normPhone,
      dto.email || null,
      dto.role_or_relation || null,
      preferencesJson,
      dto.notes || null,
    ];

    db.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      getEntityById(this.lastID)
        .then(entity => {
          if (!entity) return reject(new Error("Entidade recém-criada não foi encontrada."));
          resolve(entity);
        })
        .catch(reject);
    });
  });
}

export function updateEntity(id: number, dto: UpdateEntityDTO): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const fields: string[] = [];
    const params: any[] = [];

    if (dto.type !== undefined) {
      fields.push(`type = ?`);
      params.push(dto.type);
    }
    if (dto.name !== undefined) {
      fields.push(`name = ?`);
      params.push(dto.name);
    }
    if (dto.aliases !== undefined) {
      fields.push(`aliases = ?`);
      params.push(JSON.stringify(dto.aliases));
    }
    if (dto.contact_jid !== undefined) {
      fields.push(`contact_jid = ?`);
      params.push(dto.contact_jid);
    }
    if (dto.phone !== undefined) {
      fields.push(`phone = ?`);
      params.push(normalizePhone(dto.phone));
    }
    if (dto.email !== undefined) {
      fields.push(`email = ?`);
      params.push(dto.email);
    }
    if (dto.role_or_relation !== undefined) {
      fields.push(`role_or_relation = ?`);
      params.push(dto.role_or_relation);
    }
    if (dto.preferences !== undefined) {
      fields.push(`preferences = ?`);
      params.push(JSON.stringify(parseJsonObject(dto.preferences)));
    }
    if (dto.notes !== undefined) {
      fields.push(`notes = ?`);
      params.push(dto.notes);
    }

    if (fields.length === 0) {
      return resolve(false);
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(id);

    const sql = `UPDATE entities SET ${fields.join(', ')} WHERE id = ?`;

    db.run(sql, params, function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}

export function getEntityById(id: number): Promise<Entity | null> {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM entities WHERE id = ?", [id], (err, row: any) => {
      if (err) return reject(err);
      resolve(row ? mapRowToEntity(row) : null);
    });
  });
}

export function getEntityByNameOrAlias(nameOrAlias: string): Promise<Entity | null> {
  return new Promise((resolve, reject) => {
    const clean = nameOrAlias.trim();
    if (!clean) return resolve(null);

    // First try exact / case-insensitive name match
    db.get("SELECT * FROM entities WHERE LOWER(name) = LOWER(?)", [clean], (err, row: any) => {
      if (err) return reject(err);
      if (row) return resolve(mapRowToEntity(row));

      // Try LIKE search or alias matching
      db.all("SELECT * FROM entities", [], (err2, rows: any[]) => {
        if (err2) return reject(err2);
        if (!rows || rows.length === 0) return resolve(null);

        const lowerClean = clean.toLowerCase();

        // Check in aliases
        for (const r of rows) {
          const entity = mapRowToEntity(r);
          const aliasMatch = entity.aliases.some(a => a.toLowerCase() === lowerClean);
          if (aliasMatch) {
            return resolve(entity);
          }
        }

        // Check if entity name starts with query or query starts with entity name (com borda de palavra)
        for (const r of rows) {
          const entity = mapRowToEntity(r);
          const entNameLower = entity.name.toLowerCase();
          if (entNameLower === lowerClean) {
            return resolve(entity);
          }
        }

        resolve(null);
      });
    });
  });
}

export function getEntityByPhone(phone: string): Promise<Entity | null> {
  return new Promise((resolve, reject) => {
    const norm = normalizePhone(phone);
    if (!norm) return resolve(null);

    db.get("SELECT * FROM entities WHERE phone = ? OR phone LIKE ?", [norm, `%${norm.slice(-8)}`], (err, row: any) => {
      if (err) return reject(err);
      resolve(row ? mapRowToEntity(row) : null);
    });
  });
}

export function getEntityByJid(jid: string): Promise<Entity | null> {
  return new Promise((resolve, reject) => {
    if (!jid) return resolve(null);

    const eqJids = getEquivalentJids(jid);
    const placeholders = eqJids.map(() => '?').join(', ');

    db.get(`SELECT * FROM entities WHERE contact_jid IN (${placeholders})`, eqJids, (err, row: any) => {
      if (err) return reject(err);
      if (row) return resolve(mapRowToEntity(row));

      // Try extracting phone number from JID
      const cleanNum = jid.split('@')[0].replace(/\D/g, '');
      if (cleanNum && cleanNum.length >= 8) {
        getEntityByPhone(cleanNum).then(resolve).catch(reject);
      } else {
        resolve(null);
      }
    });
  });
}

export function searchEntities(query: string, type?: EntityType | 'all'): Promise<Entity[]> {
  return new Promise((resolve, reject) => {
    const clean = (query || '').trim().toLowerCase();

    let sql = `SELECT * FROM entities WHERE 1=1`;
    const params: any[] = [];

    if (type && type !== 'all') {
      sql += ` AND type = ?`;
      params.push(type);
    }

    db.all(sql, params, (err, rows: any[]) => {
      if (err) return reject(err);
      if (!rows || rows.length === 0) return resolve([]);

      const entities = rows.map(mapRowToEntity);
      if (!clean) return resolve(entities);

      const filtered = entities.filter(e => {
        if (e.name.toLowerCase().includes(clean)) return true;
        if (e.aliases.some(a => a.toLowerCase().includes(clean))) return true;
        if (e.role_or_relation && e.role_or_relation.toLowerCase().includes(clean)) return true;
        if (e.phone && e.phone.includes(clean)) return true;
        if (e.email && e.email.toLowerCase().includes(clean)) return true;
        if (e.notes && e.notes.toLowerCase().includes(clean)) return true;
        if (JSON.stringify(e.preferences).toLowerCase().includes(clean)) return true;
        return false;
      });

      resolve(filtered);
    });
  });
}

export function deleteEntity(id: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("DELETE FROM entity_relationships WHERE source_entity_id = ? OR target_entity_id = ?", [id, id]);
      db.run("DELETE FROM entities WHERE id = ?", [id], function (this: sqlite3.RunResult, err: Error | null) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      });
    });
  });
}

export function getAllEntities(type?: EntityType): Promise<Entity[]> {
  return new Promise((resolve, reject) => {
    let sql = "SELECT * FROM entities";
    const params: any[] = [];
    if (type) {
      sql += " WHERE type = ?";
      params.push(type);
    }
    sql += " ORDER BY name ASC";

    db.all(sql, params, (err, rows: any[]) => {
      if (err) return reject(err);
      resolve((rows || []).map(mapRowToEntity));
    });
  });
}

// ----------------------------------------------------
// Relationship Operations
// ----------------------------------------------------

export function saveRelationship(dto: CreateRelationshipDTO): Promise<EntityRelationship> {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM entity_relationships 
       WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?`,
      [dto.source_entity_id, dto.target_entity_id, dto.relation_type],
      (err, row: any) => {
        if (err) return reject(err);

        if (row) {
          // Update existing
          const newNotes = dto.context_notes || row.context_notes;
          db.run(
            `UPDATE entity_relationships SET context_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [newNotes, row.id],
            (updateErr) => {
              if (updateErr) return reject(updateErr);
              getRelationshipById(row.id).then(r => resolve(r!)).catch(reject);
            }
          );
        } else {
          // Insert new
          db.run(
            `INSERT INTO entity_relationships (source_entity_id, target_entity_id, relation_type, context_notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [dto.source_entity_id, dto.target_entity_id, dto.relation_type, dto.context_notes || null],
            function (this: sqlite3.RunResult, insertErr: Error | null) {
              if (insertErr) return reject(insertErr);
              getRelationshipById(this.lastID).then(r => resolve(r!)).catch(reject);
            }
          );
        }
      }
    );
  });
}

export function getRelationshipById(id: number): Promise<EntityRelationship | null> {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM entity_relationships WHERE id = ?", [id], async (err, row: any) => {
      if (err) return reject(err);
      if (!row) return resolve(null);

      const rel: EntityRelationship = {
        id: row.id,
        source_entity_id: row.source_entity_id,
        target_entity_id: row.target_entity_id,
        relation_type: row.relation_type,
        context_notes: row.context_notes || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };

      try {
        rel.source_entity = (await getEntityById(row.source_entity_id)) || undefined;
        rel.target_entity = (await getEntityById(row.target_entity_id)) || undefined;
        resolve(rel);
      } catch (e) {
        resolve(rel);
      }
    });
  });
}

export function getRelationshipsForEntity(
  entityId: number,
  direction: 'both' | 'outgoing' | 'incoming' = 'both'
): Promise<EntityRelationship[]> {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM entity_relationships WHERE `;
    const params: any[] = [];

    if (direction === 'outgoing') {
      sql += `source_entity_id = ?`;
      params.push(entityId);
    } else if (direction === 'incoming') {
      sql += `target_entity_id = ?`;
      params.push(entityId);
    } else {
      sql += `source_entity_id = ? OR target_entity_id = ?`;
      params.push(entityId, entityId);
    }

    db.all(sql, params, async (err, rows: any[]) => {
      if (err) return reject(err);
      if (!rows || rows.length === 0) return resolve([]);

      try {
        const results: EntityRelationship[] = [];
        for (const row of rows) {
          const rel: EntityRelationship = {
            id: row.id,
            source_entity_id: row.source_entity_id,
            target_entity_id: row.target_entity_id,
            relation_type: row.relation_type,
            context_notes: row.context_notes || null,
            created_at: row.created_at,
            updated_at: row.updated_at,
          };
          rel.source_entity = (await getEntityById(row.source_entity_id)) || undefined;
          rel.target_entity = (await getEntityById(row.target_entity_id)) || undefined;
          results.push(rel);
        }
        resolve(results);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function findRelationship(sourceId: number, targetId: number, relationType?: string): Promise<EntityRelationship | null> {
  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM entity_relationships WHERE source_entity_id = ? AND target_entity_id = ?`;
    const params: any[] = [sourceId, targetId];
    if (relationType) {
      sql += ` AND relation_type = ?`;
      params.push(relationType);
    }

    db.get(sql, params, async (err, row: any) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      getRelationshipById(row.id).then(resolve).catch(reject);
    });
  });
}

export function deleteRelationship(id: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM entity_relationships WHERE id = ?", [id], function (this: sqlite3.RunResult, err: Error | null) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}
