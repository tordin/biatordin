export type SkillCategory = "search" | "communication" | "workspace" | "system" | "shopping" | "memory" | "reasoning";

export interface SkillDefinition {
  id: string;
  name: string;
  summary: string;
  detailedPrompt: string;
  category: SkillCategory;
  tools?: string[];
  requiresTrusted?: boolean;
}
