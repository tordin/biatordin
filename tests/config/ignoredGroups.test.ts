import fs from 'fs';
import path from 'path';
import { 
  normalizeText, 
  isGroupIgnored, 
  addIgnoredGroup, 
  removeIgnoredGroup, 
  getAllIgnoredGroups 
} from '../../src/config/ignoredGroups.js';

const IGNORED_GROUPS_FILE = path.join(process.cwd(), 'data', 'ignored_groups.json');

describe('Ignored Groups & Normalization', () => {
  let originalContent: string = '[]';

  beforeAll(() => {
    if (fs.existsSync(IGNORED_GROUPS_FILE)) {
      originalContent = fs.readFileSync(IGNORED_GROUPS_FILE, 'utf-8');
    }
  });

  afterAll(() => {
    fs.writeFileSync(IGNORED_GROUPS_FILE, originalContent, 'utf-8');
  });

  beforeEach(() => {
    fs.writeFileSync(IGNORED_GROUPS_FILE, '[]', 'utf-8');
  });

  test('normalizeText deve remover acentos, converter para minúsculas e dar trim', () => {
    expect(normalizeText('  Alphaville Dom Pédro  ')).toBe('alphaville dom pedro');
    expect(normalizeText('Fámília')).toBe('familia');
    expect(normalizeText('AADP - Vendas')).toBe('aadp - vendas');
  });

  test('isGroupIgnored deve responder true com acentos e variação de caixa', () => {
    addIgnoredGroup('120363123456789@g.us', 'Alpha Dom Pedro');

    expect(isGroupIgnored('120363123456789@g.us', 'Alpha Dom Pedro')).toBe(true);
    expect(isGroupIgnored('120363123456789@g.us', 'álpha dôm pédro')).toBe(true);
    expect(isGroupIgnored('999999999999999@g.us', 'Alpha Dom Pedro')).toBe(true);
    expect(isGroupIgnored('999999999999999@g.us', 'Grupo Qualquer')).toBe(false);
  });

  test('isGroupIgnored deve corresponder entradas legadas (sem JID real)', () => {
    addIgnoredGroup('Alpha Dom Pedro', 'Alpha Dom Pedro');

    expect(isGroupIgnored('120363123456789@g.us', 'Alpha Dom Pedro')).toBe(true);
    expect(isGroupIgnored('120363123456789@g.us', 'alpha dom pedro')).toBe(true);
  });

  test('addIgnoredGroup deve atualizar o JID de uma entrada legada se um JID real for fornecido', () => {
    addIgnoredGroup('Alpha Dom Pedro', 'Alpha Dom Pedro');
    expect(getAllIgnoredGroups()[0].jid).toBe('Alpha Dom Pedro');

    // Adiciona com o JID real
    addIgnoredGroup('120363123456789@g.us', 'Alpha Dom Pedro');
    const groups = getAllIgnoredGroups();
    expect(groups.length).toBe(1);
    expect(groups[0].jid).toBe('120363123456789@g.us');
  });

  test('removeIgnoredGroup deve remover por nome normalizado ou por JID', () => {
    addIgnoredGroup('120363123456789@g.us', 'Alpha Dom Pedro');
    expect(removeIgnoredGroup('álpha dôm pédro')).toBe(true);
    expect(getAllIgnoredGroups().length).toBe(0);
  });
});
