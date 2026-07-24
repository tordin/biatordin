import { saveTask, getTasksForChat, markTaskCompleted, deleteTask } from "../../src/memory/tasks.js";

describe("Tasks SQLite Memory Layer", () => {
  const testJid = "test-tasks-chat@s.whatsapp.net";

  test("deve criar uma nova tarefa com sucesso", async () => {
    const task = await saveTask(testJid, "Resolver situação do piscineiro", "Casa", "Alta");
    expect(task).toBeDefined();
    expect(task.id).toBeGreaterThan(0);
    expect(task.title).toBe("Resolver situação do piscineiro");
    expect(task.category).toBe("Casa");
    expect(task.urgency).toBe("Alta");
    expect(task.isCompleted).toBe(false);
  });

  test("deve listar tarefas pendentes do chat", async () => {
    await saveTask(testJid, "Vender Macbook Air M2", "Vendas", "Média");
    const tasks = await getTasksForChat(testJid, "pending");
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks.some(t => t.title.includes("Macbook"))).toBe(true);
  });

  test("deve concluir uma tarefa existente", async () => {
    const tasksBefore = await getTasksForChat(testJid, "pending");
    const targetTask = tasksBefore[0];

    const success = await markTaskCompleted(targetTask.id, testJid);
    expect(success).toBe(true);

    const tasksAfter = await getTasksForChat(testJid, "pending");
    expect(tasksAfter.some(t => t.id === targetTask.id)).toBe(false);
  });

  test("deve excluir uma tarefa existente", async () => {
    const taskToDelete = await saveTask(testJid, "Tarefa temporária", "Teste", "Baixa");
    const success = await deleteTask(taskToDelete.id, testJid);
    expect(success).toBe(true);
  });
});
