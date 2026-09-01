import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { getDb, closeDb } from '../../src/memory/db.js';
import { 
  initContextDocumentsTable, 
  saveContextDocument, 
  getContextDocument, 
  appendToContextDocument 
} from '../../src/memory/contextDocuments.js';
import { checkAndCompactContextDocument } from '../../src/memory/documentCompactor.js';
import { createTopic, initTopicsTable } from '../../src/memory/topics.js';

describe('Context Documents (Living Documents)', () => {
  const chatJid = 'test_group_123';
  let testTopicId: string;

  beforeAll(async () => {
    // Note: The tests use process.env.SQLITE_DB_PATH pointing to database.test.sqlite
    await initTopicsTable();
    await initContextDocumentsTable();

    const topic = await createTopic(chatJid, 'Test Topic');
    testTopicId = topic.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  test('Deve salvar e recuperar um documento de contexto', async () => {
    await saveContextDocument(testTopicId, 'Test Topic', 'Conteudo inicial');
    const doc = await getContextDocument(testTopicId);
    
    expect(doc).toBeDefined();
    expect(doc?.content).toBe('Conteudo inicial');
    expect(doc?.title).toBe('Test Topic');
  });

  test('Deve fazer append no documento de contexto', async () => {
    await appendToContextDocument(testTopicId, 'Test Topic', 'Linha adicionada');
    const doc = await getContextDocument(testTopicId);
    
    expect(doc?.content).toContain('Conteudo inicial\nLinha adicionada');
  });

  test('Compactação não deve alterar texto se dentro do limite', async () => {
    await checkAndCompactContextDocument(testTopicId, chatJid, false);
    const doc = await getContextDocument(testTopicId);
    
    expect(doc?.content).toContain('Conteudo inicial\nLinha adicionada'); // Limite é 6000, isso não atinge
  });

  test('Deve sobrescrever o documento completamente', async () => {
    await saveContextDocument(testTopicId, 'Test Topic', 'Novo conteudo sobrescrito');
    const doc = await getContextDocument(testTopicId);
    
    expect(doc?.content).toBe('Novo conteudo sobrescrito');
  });
});
