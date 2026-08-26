import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { getContact } from '../memory/contacts.js';

/**
 * Resolvedor de JIDs do WhatsApp: LID ↔ número.
 *
 * O WhatsApp moderno identifica contatos por LID (ex: `106880328278246@lid`)
 * nas mensagens RECEBIDAS, mas o código da Bia salva missões, histórico e
 * tópicos com o número (ex: `5519999021962@s.whatsapp.net`). Esse mismatch
 * fazia a Bia perder o contexto quando o alvo de uma missão respondia.
 *
 * O Baileys mantém o mapeamento em disco: `auth_info_baileys/lid-mapping-*.json`
 * (número → LID) e `lid-mapping-*_reverse.json` (LID → número), além de emitir
 * eventos `lid-mapping.update` em runtime — ambos são consumidos aqui.
 */

// Mapas bidirecionais em memória (guardam só o "user" sem servidor)
const lidToNumber = new Map<string, string>();
const numberToLid = new Map<string, string>();

function extractUser(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/** Registra um par LID ↔ número em memória. Aceita JIDs completos ou só o user. */
export function registerLidMapping(lid: string, pn: string): void {
  const lidUser = extractUser(lid);
  const pnUser = extractUser(pn);
  if (!lidUser || !pnUser) return;
  lidToNumber.set(lidUser, pnUser);
  numberToLid.set(pnUser, lidUser);
}

/** Carrega todos os mapeamentos persistidos em disco (auth_info_baileys*). */
export function loadLidMappings(): void {
  const cwd = process.cwd();
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(cwd).filter(d => d.startsWith('auth_info_baileys'));
  } catch {
    return;
  }

  let loaded = 0;
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(cwd, dir)).filter(f => f.startsWith('lid-mapping-') && f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(cwd, dir, f), 'utf-8'));
        const base = f.replace('lid-mapping-', '').replace('.json', '');
        if (base.endsWith('_reverse')) {
          // lid-mapping-<lid>_reverse.json -> "<número>"
          const lid = base.replace('_reverse', '');
          const pn = String(content);
          registerLidMapping(lid, pn);
        } else {
          // lid-mapping-<número>.json -> "<lid>"
          const pn = base;
          const lid = String(content);
          registerLidMapping(lid, pn);
        }
        loaded++;
      } catch {
        // arquivo corrompido ou em escrita; ignora
      }
    }
  }
  if (loaded > 0) {
    logger.info(`[JID RESOLVER] ${loaded} mapeamentos LID↔número carregados (${lidToNumber.size} LIDs).`);
  }
}

/** Se o JID for @lid e o número for conhecido, retorna `numero@s.whatsapp.net`; senão null. */
export function resolveLidToNumberJid(jid: string): string | null {
  if (!jid.includes('@lid')) return null;
  const pn = lidToNumber.get(extractUser(jid));
  return pn ? `${pn}@s.whatsapp.net` : null;
}

/** Se o JID for @s.whatsapp.net e o LID for conhecido, retorna `<lid>@lid`; senão null. */
export function resolveNumberToLidJid(jid: string): string | null {
  if (!jid.includes('@s.whatsapp.net')) return null;
  const lid = numberToLid.get(extractUser(jid));
  return lid ? `${lid}@lid` : null;
}

/**
 * Retorna todos os JIDs equivalentes a um JID dado (o próprio, o número e o LID),
 * deduplicados. Usado para consultas que precisam casar em qualquer formato.
 */
export function getEquivalentJids(jid: string): string[] {
  const result = new Set<string>();
  result.add(jid);
  const asNumber = resolveLidToNumberJid(jid);
  if (asNumber) result.add(asNumber);
  const asLid = resolveNumberToLidJid(jid);
  if (asLid) result.add(asLid);
  return Array.from(result);
}

/**
 * Compara dois JIDs considerando LID ↔ número equivalentes.
 * Ex: `jidsMatch('106880328278246@lid', '5519999021962@s.whatsapp.net') === true`
 */
export function jidsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const setA = new Set(getEquivalentJids(a));
  for (const j of getEquivalentJids(b)) {
    if (setA.has(j)) return true;
  }
  return false;
}

/**
 * Retorna a chave canônica para armazenamento (histórico etc.):
 * prioriza o formato de NÚMERO, pois é o formato usado no envio.
 * Se o LID não tiver número conhecido, mantém o próprio JID.
 */
export function canonicalJid(jid: string): string {
  return resolveLidToNumberJid(jid) || jid;
}

/**
 * Retorna o melhor nome amigável para exibição ao usuário final.
 * Para grupos: Retorna o nome do grupo (ou o número base se não achar).
 * Para contatos: Retorna o nome/apelido conhecido, pushName, ou apenas o número (sem @s.whatsapp.net).
 * Oculte JIDs completos sempre!
 */
export async function formatJidForUser(jid?: string, accountName?: string): Promise<string> {
  if (!jid) return "Desconhecido";
  
  if (jid.endsWith('@g.us')) {
    // É grupo
    if (accountName) {
      try {
        const { getAllGroups } = await import('../transport/whatsapp.js');
        const groups = await getAllGroups(accountName);
        const group = groups.find((g: any) => g.jid === jid);
        if (group && group.name) {
          return group.name; // Retorna só o nome do grupo
        }
      } catch (err) {
        logger.error(`Erro ao buscar nome do grupo ${jid} em formatJidForUser:`, err);
      }
    }
    // Se não achou nome, retorna o prefixo numérico do grupo (sem @g.us)
    return jid.split('@')[0];
  }

  // Contato individual
  const cleanNumber = jid.split('@')[0];
  const canonical = canonicalJid(jid);
  const contact = await getContact(canonical);

  let bestName = contact?.name || contact?.pushName;

  // Consulta entidade no CRM Pessoal
  try {
    const { getEntityByJid, getEntityByPhone } = await import('../memory/entities.js');
    const entity = (await getEntityByJid(canonical)) || (await getEntityByPhone(cleanNumber));
    if (entity) {
      const roleStr = entity.role_or_relation ? ` (${entity.role_or_relation})` : '';
      return `${entity.name}${roleStr}`;
    }
  } catch (err) {
    logger.debug(`[JID RESOLVER] Erro ao buscar entidade para JID ${jid}:`, err);
  }
  
  if (bestName) {
    return bestName; 
  }
  
  // Sem nome: retorna apenas o número
  return cleanNumber.startsWith('55') ? `+${cleanNumber}` : cleanNumber;
}

/**
 * Resolve uma menção em linguagem natural, nome, apelido ou telefone para JID do WhatsApp
 * combinando a base do CRM de Entidades e a tabela de contatos.
 */
export async function resolveContactJid(query: string): Promise<{ jid?: string; phone?: string; name: string } | null> {
  if (!query) return null;
  const clean = query.trim();

  // 1. Consulta no CRM de Entidades
  try {
    const { resolveContactJidOrPhone } = await import('../services/entityResolver.js');
    const resolved = await resolveContactJidOrPhone(clean);
    if (resolved && (resolved.jid || resolved.phone)) {
      const jid = resolved.jid || (resolved.phone ? `${resolved.phone}@s.whatsapp.net` : undefined);
      return {
        jid,
        phone: resolved.phone || undefined,
        name: resolved.name
      };
    }
  } catch (err) {
    logger.debug(`[JID RESOLVER] Erro ao resolver entidade no CRM:`, err);
  }

  // 2. Consulta na tabela legada de contacts
  try {
    const { searchContactsByName } = await import('../memory/contacts.js');
    const contacts = await searchContactsByName(clean);
    if (contacts.length > 0) {
      const top = contacts[0];
      return {
        jid: top.jid,
        phone: top.jid.split('@')[0],
        name: top.name || top.pushName || clean
      };
    }
  } catch (err) {
    logger.debug(`[JID RESOLVER] Erro ao buscar contacts por nome:`, err);
  }

  return null;
}

