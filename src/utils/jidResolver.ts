import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

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
