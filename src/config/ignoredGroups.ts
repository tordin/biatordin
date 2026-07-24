import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

const IGNORED_GROUPS_FILE = path.join(process.cwd(), 'data', 'ignored_groups.json');

interface IgnoredGroup {
  jid: string;
  name: string;
  ignoredAt: number;
}

function loadIgnoredGroups(): IgnoredGroup[] {
  try {
    if (!fs.existsSync(IGNORED_GROUPS_FILE)) {
      fs.writeFileSync(IGNORED_GROUPS_FILE, '[]', 'utf-8');
      return [];
    }
    return JSON.parse(fs.readFileSync(IGNORED_GROUPS_FILE, 'utf-8'));
  } catch (e) {
    logger.error('[IGNORED_GROUPS] Erro ao carregar:', e);
    return [];
  }
}

function saveIgnoredGroups(groups: IgnoredGroup[]): void {
  try {
    const dir = path.dirname(IGNORED_GROUPS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(IGNORED_GROUPS_FILE, JSON.stringify(groups, null, 2), 'utf-8');
  } catch (e) {
    logger.error('[IGNORED_GROUPS] Erro ao salvar:', e);
  }
}

export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function isGroupIgnored(chatJid: string, groupName?: string): boolean {
  const groups = loadIgnoredGroups();
  const normJid = normalizeText(chatJid);
  const normName = groupName ? normalizeText(groupName) : '';

  return groups.some(g => {
    const gNormJid = normalizeText(g.jid || '');
    const gNormName = normalizeText(g.name || '');

    // 1. Correspondência exata por JID (ex: 120363xxx@g.us)
    if (gNormJid && gNormJid === normJid) return true;

    // 2. Se a entrada gravada não tem JID válido com '@', usa correspondência exata por nome completo
    if (!g.jid || !g.jid.includes('@')) {
      if (normName && gNormName && gNormName === normName) return true;
      if (gNormJid && normName && gNormJid === normName) return true;
    } else if (normName && gNormName && gNormName === normName) {
      // Se tiver o mesmo nome exato
      return true;
    }

    return false;
  });
}

export function getAllIgnoredGroups(): IgnoredGroup[] {
  return loadIgnoredGroups();
}

export function addIgnoredGroup(jid: string, name: string): boolean {
  const groups = loadIgnoredGroups();
  const normJid = normalizeText(jid);
  const normName = normalizeText(name);

  // Verifica se já está na lista por JID ou Nome (usando comparação normalizada)
  const exists = groups.some(g => {
    const gNormJid = normalizeText(g.jid || '');
    const gNormName = normalizeText(g.name || '');

    // Se o JID real coincidir
    if (jid.includes('@') && gNormJid === normJid) return true;
    // Se o nome coincidir
    if (normName && (gNormName === normName || gNormName.includes(normName) || normName.includes(gNormName))) return true;
    return false;
  });

  if (exists) {
    // Se já existia mas tinha um JID genérico e agora temos o JID real (@g.us), atualiza!
    if (jid.includes('@')) {
      let updated = false;
      for (const g of groups) {
        const gNormName = normalizeText(g.name || '');
        const gNormJid = normalizeText(g.jid || '');
        if (gNormName === normName || gNormName.includes(normName) || normName.includes(gNormName) || gNormJid === normName) {
          if (!g.jid.includes('@')) {
            g.jid = jid;
            g.name = name;
            updated = true;
          }
        }
      }
      if (updated) {
        saveIgnoredGroups(groups);
        logger.info(`[IGNORED_GROUPS] JID do grupo "${name}" atualizado para ${jid}`);
        return true;
      }
    }
    return false;
  }

  groups.push({ jid, name, ignoredAt: Date.now() });
  saveIgnoredGroups(groups);
  logger.info(`[IGNORED_GROUPS] Grupo adicionado: ${name} (${jid})`);
  return true;
}

export function removeIgnoredGroup(target: string): boolean {
  const groups = loadIgnoredGroups();
  const normTarget = normalizeText(target);
  const before = groups.length;

  const filtered = groups.filter(g => {
    const gNormJid = normalizeText(g.jid || '');
    const gNormName = normalizeText(g.name || '');

    const matchJid = gNormJid && gNormJid === normTarget;
    const matchName = gNormName && (gNormName === normTarget || gNormName.includes(normTarget) || normTarget.includes(gNormName));
    return !(matchJid || matchName);
  });

  if (filtered.length === before) return false;
  saveIgnoredGroups(filtered);
  logger.info(`[IGNORED_GROUPS] Grupo removido: ${target}`);
  return true;
}

export function isGroupManagementCommand(text: string): { action: 'ignore' | 'unignore' | null } {
  const lower = text.toLowerCase().trim();
  // "Bia, ignore esse grupo", "Bia, para de prestar atenção aqui", etc.
  if (/ignore|ignorar|pare de prestar atenção|para de responder|silencia|nao responde/.test(lower)) {
    return { action: 'ignore' };
  }
  // "Bia, volte a prestar atenção", "Bia, atenda esse grupo", etc.
  if (/volte a prestar|atende|atender|para de ignorar|deixa de ignorar|presta atenção/.test(lower)) {
    return { action: 'unignore' };
  }
  return { action: null };
}
