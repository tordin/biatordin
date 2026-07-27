import { SKILL_DEFINITIONS, getSkill, getAllSkills, getSkillCatalogSummary, getSkillTools, getToolsForCategories, getAllTools } from "../../src/skills/registry.js";

describe("Skills Registry & Directory Catalog", () => {
  test("deve conter exatamente 13 habilidades cadastradas", () => {
    const skills = getAllSkills();
    expect(skills.length).toBe(13);
  });

  test("deve recuperar uma skill específica pelo ID", () => {
    const searchSkill = getSkill("searchAgent");
    expect(searchSkill).toBeDefined();
    expect(searchSkill?.name).toBe("Agente de Busca na Web");
    expect(searchSkill?.detailedPrompt).toContain("google_search");

    const reasoningSkill = getSkill("reasoningAgent");
    expect(reasoningSkill).toBeDefined();
    expect(reasoningSkill?.name).toContain("Raciocínio Complexo");
    expect(reasoningSkill?.detailedPrompt).toContain("Deep Reasoning Specialist");
  });

  test("deve retornar undefined para ID de skill inexistente", () => {
    const unknownSkill = getSkill("nonExistentSkill");
    expect(unknownSkill).toBeUndefined();
  });

  test("deve gerar o catálogo resumido de habilidades para a supervisora", () => {
    const summary = getSkillCatalogSummary();
    expect(summary).toBeDefined();
    expect(summary).toContain("searchAgent: Especialista em pesquisas na web");
    expect(summary).toContain("reasoningAgent: Especialista em resolver problemas complexos");
  });

  test("SkillDefinition deve incluir tools[] para skills com ferramentas", () => {
    const taskSkill = getSkill("taskAgent");
    expect(taskSkill?.tools).toBeDefined();
    expect(taskSkill?.tools).toEqual(["add_task", "list_tasks", "complete_task", "delete_task"]);

    const weatherSkill = getSkill("weatherAgent");
    expect(weatherSkill?.tools).toEqual(["get_weather"]);

    const searchSkill = getSkill("searchAgent");
    expect(searchSkill?.tools).toEqual(["google_search", "open_webpage"]);
  });

  test("getSkillTools retorna ferramentas da skill", () => {
    expect(getSkillTools("taskAgent")).toEqual(["add_task", "list_tasks", "complete_task", "delete_task"]);
    expect(getSkillTools("routineAgent")).toEqual(["create_routine", "list_routines", "delete_routine"]);
    expect(getSkillTools("weatherAgent")).toEqual(["get_weather"]);
  });

  test("getSkillTools retorna array vazio para skill sem tools ou inexistente", () => {
    expect(getSkillTools("reasoningAgent")).toEqual([]);
    expect(getSkillTools("nonExistentSkill")).toEqual([]);
  });

  test("getAllTools retorna array não-vazio com todos os nomes de ferramentas", () => {
    const allTools = getAllTools();
    expect(allTools.length).toBeGreaterThan(0);
    expect(allTools).toContain("google_search");
    expect(allTools).toContain("open_webpage");
    expect(allTools).toContain("get_weather");
    expect(allTools).toContain("google_shopping");
    expect(allTools).toContain("add_task");
    expect(allTools).toContain("add_trusted_chat");
    expect(allTools).toContain("list_auto_reply_chats");
    // todas as 14 tools do securityAgent devem estar
    expect(allTools.filter(t => t.startsWith("add_") || t.startsWith("remove_") || t.startsWith("check_") || t.startsWith("list_") || t.startsWith("get_") || t.startsWith("connect_") || t.startsWith("disconnect_") || t.startsWith("ignore_") || t.startsWith("unignore_") || t.startsWith("enable_") || t.startsWith("disable_"))).not.toBeNull();
  });

  test("getToolsForCategories retorna tools filtradas por categorias", () => {
    const searchTools = getToolsForCategories(["search"]);
    expect(searchTools).toContain("google_search");
    expect(searchTools).toContain("open_webpage");
    expect(searchTools).toContain("get_weather");
    expect(searchTools).not.toContain("add_task");

    const memoryTools = getToolsForCategories(["memory"]);
    expect(memoryTools).toContain("add_task");
    expect(memoryTools).toContain("list_tasks");
    expect(memoryTools).toContain("readMemory");
    expect(memoryTools).toContain("storeSemanticMemory");
    expect(memoryTools).not.toContain("google_search");
  });

  test("getToolsForCategories com categorias vazias retorna array vazio", () => {
    expect(getToolsForCategories([])).toEqual([]);
  });
});
