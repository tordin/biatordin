import { SKILL_DEFINITIONS, getSkill, getAllSkills, getSkillCatalogSummary } from "../../src/skills/registry.js";

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
    expect(summary).toContain("1. searchAgent: Especialista em pesquisas na web.");
    expect(summary).toContain("2. chitchat: Especialista em conversa geral");
    expect(summary).toContain("13. reasoningAgent: Especialista em resolver problemas complexos");
  });
});
