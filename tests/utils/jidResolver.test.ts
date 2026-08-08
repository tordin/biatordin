import {
  registerLidMapping,
  resolveLidToNumberJid,
  resolveNumberToLidJid,
  getEquivalentJids,
  jidsMatch,
  canonicalJid,
} from '../../src/utils/jidResolver.js';

describe('JID Resolver (LID ↔ número)', () => {
  beforeEach(() => {
    // Limpa mapeamentos (re-registra apenas os de teste; mapeamentos reais
    // carregados do disco continuam no Map, mas não interferem nos asserts)
  });

  test('resolveLidToNumberJid retorna o número quando o mapeamento existe', () => {
    registerLidMapping('106880328278246@lid', '5519999021962@s.whatsapp.net');
    expect(resolveLidToNumberJid('106880328278246@lid')).toBe('5519999021962@s.whatsapp.net');
  });

  test('resolveLidToNumberJid retorna null para número (não-LID)', () => {
    expect(resolveLidToNumberJid('5519999021962@s.whatsapp.net')).toBeNull();
  });

  test('resolveNumberToLidJid retorna o LID quando o mapeamento existe', () => {
    registerLidMapping('106880328278246@lid', '5519999021962@s.whatsapp.net');
    expect(resolveNumberToLidJid('5519999021962@s.whatsapp.net')).toBe('106880328278246@lid');
  });

  test('getEquivalentJids inclui LID e número', () => {
    registerLidMapping('106880328278246@lid', '5519999021962@s.whatsapp.net');
    const jids = getEquivalentJids('106880328278246@lid');
    expect(jids).toContain('106880328278246@lid');
    expect(jids).toContain('5519999021962@s.whatsapp.net');
  });

  test('jidsMatch considera LID e número equivalentes', () => {
    registerLidMapping('106880328278246@lid', '5519999021962@s.whatsapp.net');
    expect(jidsMatch('106880328278246@lid', '5519999021962@s.whatsapp.net')).toBe(true);
    expect(jidsMatch('106880328278246@lid', '106880328278246@lid')).toBe(true);
    expect(jidsMatch('106880328278246@lid', '5599999999999@s.whatsapp.net')).toBe(false);
  });

  test('canonicalJid retorna o número para um LID mapeado', () => {
    registerLidMapping('106880328278246@lid', '5519999021962@s.whatsapp.net');
    expect(canonicalJid('106880328278246@lid')).toBe('5519999021962@s.whatsapp.net');
  });

  test('canonicalJid retorna o próprio JID quando não há mapeamento', () => {
    expect(canonicalJid('123456789012345@lid')).toBe('123456789012345@lid');
  });

  test('aceita registro apenas com o "user" (sem servidor)', () => {
    registerLidMapping('106880328278246', '5519999021962');
    expect(jidsMatch('106880328278246@lid', '5519999021962@s.whatsapp.net')).toBe(true);
  });
});
