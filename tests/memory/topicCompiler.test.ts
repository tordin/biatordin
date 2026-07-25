import { compileActiveTopicContext } from "../../src/memory/topicCompiler.js";
import { createTopic } from "../../src/memory/topics.js";
import { saveTask } from "../../src/memory/tasks.js";
import { saveRoutine } from "../../src/memory/routines.js";

describe("Topic Compiler Context Injector", () => {
  const testChatJid = "test-topic-compiler@s.whatsapp.net";

  test("deve retornar string vazia para topicId nulo ou inexistente", async () => {
    const context = await compileActiveTopicContext(testChatJid, "", true);
    expect(context).toBe("");
  });

  test("deve compilar contexto estruturado do assunto incluindo tarefas e rotinas", async () => {
    const topic = await createTopic(testChatJid, "Festa da Cecília");
    await saveTask(testChatJid, "Comprar balões", "Festa", "Alta", undefined, topic.id);
    await saveRoutine(testChatJid, "0 10 * * *", "Verificar buffet", topic.id);

    const compiled = await compileActiveTopicContext(testChatJid, topic.id, true);
    expect(compiled).toContain("[ASSUNTO ATIVO: Festa da Cecília]");
    expect(compiled).toContain("Comprar balões");
    expect(compiled).toContain("Verificar buffet");
  });
});
