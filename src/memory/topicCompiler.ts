import { getTopic } from './topics.js';
import { getTasksForChat } from './tasks.js';
import { getRoutinesForChat } from './routines.js';
import { getMemoriesByTopicId } from './vectorMemory.js';

export async function compileActiveTopicContext(chatJid: string, topicId: string, isTrustedChat: boolean): Promise<string> {
  if (!topicId) return "";

  const topic = await getTopic(topicId);
  if (!topic) return "";

  let hasContent = false;
  let context = `[ASSUNTO ATIVO: ${topic.title}]\n\n`;

  // Tarefas
  const tasks = await getTasksForChat(chatJid, 'all', undefined, isTrustedChat, topicId);
  if (tasks && tasks.length > 0) {
    hasContent = true;
    context += "Tarefas relacionadas:\n";
    tasks.forEach(t => {
      const status = t.isCompleted ? "[x]" : "[ ]";
      context += `- ${status} ${t.title} (Urgência: ${t.urgency})\n`;
    });
    context += "\n";
  }

  // Rotinas
  const routines = await getRoutinesForChat(chatJid, topicId);
  if (routines && routines.length > 0) {
    hasContent = true;
    context += "Lembretes/Rotinas relacionadas:\n";
    routines.forEach(r => {
      context += `- ${r.prompt} (Cron: ${r.cronExpression})\n`;
    });
    context += "\n";
  }

  // Memórias
  const memories = await getMemoriesByTopicId(topicId, 20);
  if (memories && memories.length > 0) {
    hasContent = true;
    context += "Fatos e anotações sobre o assunto:\n";
    memories.forEach(m => {
      context += `- ${m.content}\n`;
    });
    context += "\n";
  }

  if (!hasContent) return "";

  return context.trim();
}
