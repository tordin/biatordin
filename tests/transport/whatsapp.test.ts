import { 
  getSilenceDelayForMessage, 
  BASE_SILENCE_THRESHOLD_MS, 
  INCOMPLETE_SILENCE_THRESHOLD_MS,
  isMessageFromBia,
  isBroadcastJid,
  normalizeJid
} from '../../src/transport/whatsapp.js';

describe('WhatsApp Debounce Timing', () => {
  it('should return BASE_SILENCE_THRESHOLD_MS (2.5s) for messages ending with strong punctuation', () => {
    expect(getSilenceDelayForMessage('Olá! Tudo bem?')).toBe(BASE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Preciso de ajuda com a agenda.')).toBe(BASE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Que dia é hoje?')).toBe(BASE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Uau!')).toBe(BASE_SILENCE_THRESHOLD_MS);
  });

  it('should return BASE_SILENCE_THRESHOLD_MS (2.5s) for common short greetings and replies without punctuation', () => {
    expect(getSilenceDelayForMessage('oi')).toBe(BASE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Olá')).toBe(BASE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Bom dia')).toBe(BASE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Bia')).toBe(BASE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Valeu')).toBe(BASE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('obrigado')).toBe(BASE_SILENCE_THRESHOLD_MS);
  });

  it('should return INCOMPLETE_SILENCE_THRESHOLD_MS (15s) for messages ending with ellipsis, commas, colons or dashes', () => {
    expect(getSilenceDelayForMessage('vou precisar de ajuda com...')).toBe(INCOMPLETE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('estou pensando em,')).toBe(INCOMPLETE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('segue a lista:')).toBe(INCOMPLETE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('talvez -')).toBe(INCOMPLETE_SILENCE_THRESHOLD_MS);
  });

  it('should return INCOMPLETE_SILENCE_THRESHOLD_MS (15s) for messages ending with coordinate conjunctions, prepositions, or incomplete verbs', () => {
    expect(getSilenceDelayForMessage('Preciso de ajuda para')).toBe(INCOMPLETE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Quero ver as datas e')).toBe(INCOMPLETE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Ia fazer a busca mas')).toBe(INCOMPLETE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Estou indo pro')).toBe(INCOMPLETE_SILENCE_THRESHOLD_MS);
    expect(getSilenceDelayForMessage('Acho que vou')).toBe(INCOMPLETE_SILENCE_THRESHOLD_MS);
  });

  it('should return 5000ms for ambiguous messages (no punctuation but no explicit incomplete indicators)', () => {
    expect(getSilenceDelayForMessage('me ajuda com a agenda')).toBe(5000);
    expect(getSilenceDelayForMessage('quais são as corridas de f1')).toBe(5000);
  });
});

describe('WhatsApp Message Filtering & Account Isolation', () => {
  it('should correctly normalize JIDs removing device suffixes', () => {
    expect(normalizeJid('5511999999999:12@s.whatsapp.net')).toBe('5511999999999@s.whatsapp.net');
    expect(normalizeJid('123456789:0@lid')).toBe('123456789@lid');
    expect(normalizeJid('120363425678591898@g.us')).toBe('120363425678591898@g.us');
  });

  it('should return false for isMessageFromBia when botJids is empty or user is external', () => {
    expect(isMessageFromBia('5511888888888@s.whatsapp.net')).toBe(false);
    expect(isMessageFromBia('120363425678591898@g.us')).toBe(false);
  });

  it('should correctly identify status and broadcast JIDs', () => {
    expect(isBroadcastJid('status@broadcast')).toBe(true);
    expect(isBroadcastJid('12345678@broadcast')).toBe(true);
    expect(isBroadcastJid('status@broadcast:12')).toBe(true);
    expect(isBroadcastJid('5511999999999@s.whatsapp.net')).toBe(false);
    expect(isBroadcastJid('120363425678591898@g.us')).toBe(false);
    expect(isBroadcastJid(null)).toBe(false);
    expect(isBroadcastJid(undefined)).toBe(false);
  });
});

describe('WhatsApp sendIntermediateMessage JID resolution', () => {
  it('should safely extract JID from composite thread IDs with account prefix and topic UUID', async () => {
    const { sendIntermediateMessage } = await import('../../src/transport/whatsapp.js');
    // Calling with no initialized socket should log error and return undefined without crashing
    const res = await sendIntermediateMessage(
      'main_5519997064504@s.whatsapp.net_92f74c9f-921d-463b-be32-9180db7a08c2',
      'Mensagem intermediária de teste'
    );
    expect(res).toBeUndefined();
  });
});

