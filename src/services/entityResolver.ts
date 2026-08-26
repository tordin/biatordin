import {
  Entity,
  EntityRelationship,
  getAllEntities,
  getEntityById,
  getEntityByNameOrAlias,
  getEntityByPhone,
  getEntityByJid,
  getRelationshipsForEntity,
  searchEntities
} from '../memory/entities.js';
import { logger } from '../utils/logger.js';

export interface ResolvedEntityMatch {
  entity: Entity;
  score: number; // 0 to 1
  matchReason: string;
  relationships?: EntityRelationship[];
}

export interface ResolvedContactInfo {
  name: string;
  jid: string | null;
  phone: string | null;
  email: string | null;
  role_or_relation: string | null;
  preferences: Record<string, any>;
  entity: Entity;
  matchReason: string;
}

/**
 * Normaliza string para comparação sem acentos e em minúsculas
 */
export function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Extrai tokens úteis de uma consulta
 */
function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[\s,./\-_+&|]+/)
    .filter(w => w.length > 1 && !['de', 'da', 'do', 'das', 'dos', 'o', 'a', 'os', 'as', 'em', 'para', 'pra', 'pro', 'com', 'e', 'um', 'uma'].includes(w));
}

/**
 * Resolve uma menção em linguagem natural para uma Entidade do CRM
 */
export async function resolveEntity(query: string): Promise<ResolvedEntityMatch | null> {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) return null;

  const normQuery = normalizeText(cleanQuery);

  // 1. Busca Direta por Telefone / JID se parecer com número ou JID
  if (cleanQuery.includes('@') || cleanQuery.replace(/\D/g, '').length >= 8) {
    const byJid = await getEntityByJid(cleanQuery);
    if (byJid) {
      const rels = await getRelationshipsForEntity(byJid.id);
      return { entity: byJid, score: 1.0, matchReason: `Match exato por JID/contato (${cleanQuery})`, relationships: rels };
    }

    const byPhone = await getEntityByPhone(cleanQuery);
    if (byPhone) {
      const rels = await getRelationshipsForEntity(byPhone.id);
      return { entity: byPhone, score: 1.0, matchReason: `Match exato por telefone (${cleanQuery})`, relationships: rels };
    }
  }

  // 2. Busca Direta por Nome ou Apelido Exato
  const directEntity = await getEntityByNameOrAlias(cleanQuery);
  if (directEntity) {
    const rels = await getRelationshipsForEntity(directEntity.id);
    return {
      entity: directEntity,
      score: 1.0,
      matchReason: `Match exato por nome ou apelido ("${cleanQuery}" -> ${directEntity.name})`,
      relationships: rels
    };
  }

  const allEntities = await getAllEntities();
  if (allEntities.length === 0) return null;

  const tokens = tokenize(cleanQuery);

  // 3. Travessia Inteligente no Grafo de Relacionamentos (Prioridade alta para consultas relacionais compostas)
  // Exemplos:
  // - "engenheiro da reforma" / "engenheiro da obra"
  // - "pediatra do Theo" / "médico do Theo"
  // - "arquiteto do projeto X"
  for (const ent of allEntities) {
    const entRels = await getRelationshipsForEntity(ent.id);

    for (const rel of entRels) {
      const otherEnt = rel.source_entity_id === ent.id ? rel.target_entity : rel.source_entity;
      if (!otherEnt) continue;

      const normRelType = normalizeText(rel.relation_type);
      const normRelNotes = normalizeText(rel.context_notes || '');
      const normOtherName = normalizeText(otherEnt.name);
      const normOtherAliases = otherEnt.aliases.map(normalizeText);

      // Checa se a query menciona o tipo de relação E a entidade conectada
      // Ex: "engenheiro" e "reforma", "pediatra" e "theo"
      const mentionsRelation = tokens.some(t => normRelType.includes(t) || normRelNotes.includes(t) || (ent.role_or_relation && normalizeText(ent.role_or_relation).includes(t)));
      const mentionsTarget = tokens.some(t => normOtherName.includes(t) || normOtherAliases.some(a => a.includes(t)));

      if (mentionsRelation && mentionsTarget) {
        return {
          entity: ent,
          score: 0.96,
          matchReason: `Match por relação no grafo (${ent.name} é [${rel.relation_type}] vinculado a ${otherEnt.name})`,
          relationships: entRels
        };
      }
    }
  }

  // 4. Match por Papel / Relação Direta (ex: "minha esposa", "esposa", "contador", "pediatra")
  for (const ent of allEntities) {
    if (ent.role_or_relation) {
      const normRole = normalizeText(ent.role_or_relation);
      if (normRole === normQuery || normQuery.includes(normRole) || normRole.includes(normQuery)) {
        const rels = await getRelationshipsForEntity(ent.id);
        return {
          entity: ent,
          score: 0.90,
          matchReason: `Match por papel/relação ("${ent.role_or_relation}")`,
          relationships: rels
        };
      }
    }
  }

  // 5. Match Parcial / Fuzzy nos campos (Search LIKE)
  const searchResults = await searchEntities(cleanQuery);
  if (searchResults.length > 0) {
    // Escolhe o melhor resultado comparando tokens
    let bestMatch: Entity = searchResults[0];
    let bestScore = 0.5;

    for (const cand of searchResults) {
      const candTokens = [
        ...tokenize(cand.name),
        ...cand.aliases.flatMap(tokenize),
        ...(cand.role_or_relation ? tokenize(cand.role_or_relation) : []),
        ...(cand.notes ? tokenize(cand.notes) : [])
      ];

      const overlap = tokens.filter(t => candTokens.some(ct => ct.includes(t) || t.includes(ct))).length;
      const score = 0.5 + (overlap / Math.max(tokens.length, 1)) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = cand;
      }
    }

    const rels = await getRelationshipsForEntity(bestMatch.id);
    return {
      entity: bestMatch,
      score: bestScore,
      matchReason: `Match por similaridade de texto ("${cleanQuery}" -> ${bestMatch.name})`,
      relationships: rels
    };
  }

  return null;
}

/**
 * Resolve e recupera os dados de contato completos e preferências de uma entidade
 */
export async function resolveContactJidOrPhone(query: string): Promise<ResolvedContactInfo | null> {
  const match = await resolveEntity(query);
  if (!match) return null;

  const entity = match.entity;
  return {
    name: entity.name,
    jid: entity.contact_jid,
    phone: entity.phone,
    email: entity.email,
    role_or_relation: entity.role_or_relation,
    preferences: entity.preferences || {},
    entity,
    matchReason: match.matchReason
  };
}

/**
 * Gera o dossiê completo de uma entidade e todas as suas conexões para contexto de LLM
 */
export async function resolveEntityContext(query: string): Promise<string> {
  const match = await resolveEntity(query);
  if (!match) {
    return `Nenhuma entidade correspondente a "${query}" foi encontrada no CRM Pessoal.`;
  }

  const { entity, matchReason } = match;
  const relationships = await getRelationshipsForEntity(entity.id);

  let output = `### Ficha de Entidade: ${entity.name} (${entity.type.toUpperCase()})\n`;
  output += `- **ID:** ${entity.id}\n`;
  output += `- **Nome Principal:** ${entity.name}\n`;
  if (entity.aliases.length > 0) {
    output += `- **Apelidos / Variações:** ${entity.aliases.join(', ')}\n`;
  }
  if (entity.role_or_relation) {
    output += `- **Relação com o Luiz / Papel:** ${entity.role_or_relation}\n`;
  }
  if (entity.phone) {
    output += `- **Telefone:** ${entity.phone}\n`;
  }
  if (entity.contact_jid) {
    output += `- **WhatsApp JID:** ${entity.contact_jid}\n`;
  }
  if (entity.email) {
    output += `- **E-mail:** ${entity.email}\n`;
  }

  // Preferences
  const prefKeys = Object.keys(entity.preferences || {});
  if (prefKeys.length > 0) {
    output += `- **Preferências Declaradas:**\n`;
    for (const key of prefKeys) {
      output += `  • ${key}: ${JSON.stringify(entity.preferences[key])}\n`;
    }
  }

  if (entity.notes) {
    output += `- **Observações:** ${entity.notes}\n`;
  }

  // Graph Relationships
  if (relationships.length > 0) {
    output += `- **Conexões e Relacionamentos no Grafo (${relationships.length}):**\n`;
    for (const rel of relationships) {
      const isSource = rel.source_entity_id === entity.id;
      const other = isSource ? rel.target_entity : rel.source_entity;
      const otherName = other ? `${other.name} (${other.type})` : `ID ${isSource ? rel.target_entity_id : rel.source_entity_id}`;
      const direction = isSource ? `-> [${rel.relation_type}] ->` : `<- [${rel.relation_type}] <-`;
      const notes = rel.context_notes ? ` (Contexto: ${rel.context_notes})` : '';
      output += `  • ${entity.name} ${direction} ${otherName}${notes}\n`;
    }
  } else {
    output += `- **Conexões no Grafo:** Nenhuma relação cadastrada até o momento.\n`;
  }

  output += `\n*(Match: ${matchReason})*`;

  return output;
}
