import { 
  initTopicsTable, 
  createTopic, 
  getRecentTopics, 
  getTopic, 
  updateTopicActivity,
  getOrCreateTopicByTitle
} from '../../src/memory/topics.js';

describe('Topics Database Manager', () => {
  beforeAll(async () => {
    await initTopicsTable();
  });

  it('should create and retrieve topics correctly', async () => {
    const chatJid = 'test-chat@s.whatsapp.net';
    const title = 'Test Topic F1';
    
    const newTopic = await createTopic(chatJid, title);
    expect(newTopic.id).toBeDefined();
    expect(newTopic.chatJid).toBe(chatJid);
    expect(newTopic.title).toBe(title);
    expect(newTopic.status).toBe('active');

    const fetchedTopic = await getTopic(newTopic.id);
    expect(fetchedTopic).not.toBeNull();
    expect(fetchedTopic?.title).toBe(title);
  });

  it('should return recent topics ordered by activity', async () => {
    const chatJid = 'test-recent@s.whatsapp.net';
    const t1 = await createTopic(chatJid, 'Topic 1');
    const t2 = await createTopic(chatJid, 'Topic 2');
    
    await new Promise((r) => setTimeout(r, 10));
    await updateTopicActivity(t1.id);

    const recent = await getRecentTopics(chatJid);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent[0].id).toBe(t1.id);
    expect(recent[1].id).toBe(t2.id);
  });

  it('should get existing topic or create new topic by title (getOrCreateTopicByTitle)', async () => {
    const chatJid = 'test-get-create@s.whatsapp.net';
    const topicTitle = 'Viagem de Férias';

    const firstCall = await getOrCreateTopicByTitle(chatJid, topicTitle);
    expect(firstCall.title).toBe(topicTitle);

    const secondCall = await getOrCreateTopicByTitle(chatJid, topicTitle);
    expect(secondCall.id).toBe(firstCall.id);
  });
});
