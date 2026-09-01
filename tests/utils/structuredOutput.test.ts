import { jest, describe, test, expect } from '@jest/globals';
import { z } from "zod";
import { invokeStructuredWithFallback, extractAndParseJson } from "../../src/utils/structuredOutput.js";
import { strictOptional, strictArray } from "../../src/utils/zodStrict.js";
import { HumanMessage } from "@langchain/core/messages";

// ---------------------------------------------------------------------------
// Schemas reais do projeto (importados para testes de conformidade)
// ---------------------------------------------------------------------------
import { ConsolidationResultSchema, DemoteItemSchema } from "../../src/memory/memoryConsolidator.js";
import { EvaluationSchema } from "../../src/agents/evaluator.js";
import { ArbiterDecisionSchema, ArbiterVerdictSchema } from "../../src/memory/semanticArbiter.js";

// ---------------------------------------------------------------------------
// Helpers de introspecção para testes de strict-mode compliance
// ---------------------------------------------------------------------------

/**
 * Verifica recursivamente que um schema Zod não contém nenhum ZodOptional sem default.
 * ZodOptional sem ZodDefault gera campos sem entrada no `required` do JSON Schema,
 * o que é rejeitado com HTTP 400 pelo OpenAI/DeepSeek em strict mode.
 */
function hasUnprotectedOptional(schema: z.ZodType, path = ""): string[] {
  const violations: string[] = [];

  if (schema instanceof z.ZodOptional) {
    // Optional sem default = violação
    violations.push(`Campo ${path || "(raiz)"} usa .optional() sem .default() — incompatível com Strict Mode`);
  }

  // Percorre schema interno se for wrapper
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) {
    const inner = (schema as any)._def.innerType ?? (schema as any)._def.schema;
    if (inner) {
      violations.push(...hasUnprotectedOptional(inner, path));
    }
  }

  // Percorre objeto
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    for (const [key, value] of Object.entries(shape)) {
      violations.push(...hasUnprotectedOptional(value, path ? `${path}.${key}` : key));
    }
  }

  // Percorre array
  if (schema instanceof z.ZodArray) {
    const itemType = (schema as any)._def.type;
    violations.push(...hasUnprotectedOptional(itemType, `${path}[]`));
  }

  return violations;
}

describe("Structured Output Fallback Utility & Schema Resilience", () => {
  const dummySchema = z.object({
    greeting: z.string(),
    confidence: z.number()
  });

  const resilientSchema = z.object({
    plan: z.array(z.string()).nullable().default(null),
    nextAgent: z.enum(["FINISH", "searchAgent", "taskAgent"]),
    specialistTask: z.string().nullable().default(null).transform(val => {
      if (!val) return null;
      const trimmed = val.trim();
      return trimmed === "" || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "undefined" ? null : trimmed;
    }),
    reason: z.string().nullable().default(null),
    response: z.string().nullable().default(null),
    intermediateMessage: z.string().nullable().default(null),
    contextDataUpdate: z.record(z.string(), z.any()).nullable().default(null)
  });

  // ---------------------------------------------------------------------------
  // Pilar 4: Conformidade Strict-Mode de todos os schemas do projeto
  // ---------------------------------------------------------------------------

  describe("Schema Strict-Mode Compliance (Pilar 1)", () => {
    test("ConsolidationResultSchema não deve ter .optional() não protegido", () => {
      const violations = hasUnprotectedOptional(ConsolidationResultSchema);
      expect(violations).toEqual([]);
    });

    test("DemoteItemSchema não deve ter .optional() não protegido", () => {
      const violations = hasUnprotectedOptional(DemoteItemSchema);
      expect(violations).toEqual([]);
    });

    test("EvaluationSchema não deve ter .optional() não protegido", () => {
      const violations = hasUnprotectedOptional(EvaluationSchema);
      expect(violations).toEqual([]);
    });

    test("ArbiterDecisionSchema não deve ter .optional() não protegido", () => {
      const violations = hasUnprotectedOptional(ArbiterDecisionSchema);
      expect(violations).toEqual([]);
    });

    test("ArbiterVerdictSchema não deve ter .optional() não protegido", () => {
      const violations = hasUnprotectedOptional(ArbiterVerdictSchema);
      expect(violations).toEqual([]);
    });

    test("Schema de exemplo com .optional() deve ser detectado como violação", () => {
      const badSchema = z.object({
        name: z.string(),
        nickname: z.string().optional() // Deliberadamente problemático
      });
      const violations = hasUnprotectedOptional(badSchema);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain("nickname");
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers zodStrict
  // ---------------------------------------------------------------------------

  describe("zodStrict helpers", () => {
    test("strictOptional() deve retornar .nullable().default(null)", () => {
      const schema = z.object({ x: strictOptional(z.string()) });
      const violations = hasUnprotectedOptional(schema);
      expect(violations).toEqual([]);

      // Deve aceitar null e aplicar default
      expect(schema.parse({})).toEqual({ x: null });
      expect(schema.parse({ x: "hello" })).toEqual({ x: "hello" });
      expect(schema.parse({ x: null })).toEqual({ x: null });
    });

    test("strictArray() deve retornar .default([])", () => {
      const schema = z.object({ tags: strictArray(z.string()) });
      // Deve aplicar default [] quando omitido
      expect(schema.parse({})).toEqual({ tags: [] });
      expect(schema.parse({ tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
    });
  });

  // ---------------------------------------------------------------------------
  // extractAndParseJson
  // ---------------------------------------------------------------------------

  describe("extractAndParseJson", () => {
    test("deve extrair e parsear objeto JSON padrão", () => {
      const raw = '{"nextAgent": "FINISH", "response": "[SILENT]"}';
      expect(extractAndParseJson(raw)).toEqual({ nextAgent: "FINISH", response: "[SILENT]" });
    });

    test("deve extrair e parsear JSON envolto em markdown fences ```json", () => {
      const raw = 'Aqui está a decisão:\n```json\n{\n  "nextAgent": "FINISH",\n  "response": "Olá!"\n}\n```';
      expect(extractAndParseJson(raw)).toEqual({ nextAgent: "FINISH", response: "Olá!" });
    });

    test("deve extrair e parsear array JSON [...]", () => {
      const raw = '[\n  {"id": 1, "name": "Item 1"},\n  {"id": 2, "name": "Item 2"}\n]';
      expect(extractAndParseJson(raw)).toEqual([
        { id: 1, name: "Item 1" },
        { id: 2, name: "Item 2" }
      ]);
    });

    test("deve sanitizar vírgulas extras e chaves vazias (: ,)", () => {
      const raw = '{"nextAgent": "FINISH", "plan": , "response": "Oi", }';
      expect(extractAndParseJson(raw)).toEqual({ nextAgent: "FINISH", plan: null, response: "Oi" });
    });

    test("deve retornar null para texto sem nenhum JSON", () => {
      expect(extractAndParseJson("Texto sem delimitadores")).toBeNull();
      expect(extractAndParseJson("")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // invokeStructuredWithFallback — camadas de resiliência
  // ---------------------------------------------------------------------------

  describe("invokeStructuredWithFallback", () => {
    test("deve invocar o modelo com structured output com sucesso", async () => {
      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue({
          invoke: jest.fn<any>().mockResolvedValue({ greeting: "Olá!", confidence: 0.95 })
        })
      };

      const result = await invokeStructuredWithFallback(
        mockModel,
        dummySchema,
        [new HumanMessage("Oi")],
        { name: "TestOutput" }
      );

      expect(result).toEqual({ greeting: "Olá!", confidence: 0.95 });
    });

    test("deve aceitar payload parcial com chaves omitidas sem lançar ZodError de undefined", async () => {
      const partialDecision = {
        nextAgent: "FINISH",
        response: "[SILENT]"
        // plan, specialistTask, reason, intermediateMessage, contextDataUpdate estão OMITIDOS (undefined)
      };

      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue({
          invoke: jest.fn<any>().mockResolvedValue(partialDecision)
        })
      };

      const result = await invokeStructuredWithFallback(
        mockModel,
        resilientSchema,
        [new HumanMessage("Oi")],
        { name: "SupervisorDecision" }
      );

      expect(result.nextAgent).toBe("FINISH");
      expect(result.response).toBe("[SILENT]");
      expect(result.plan).toBeNull();
      expect(result.specialistTask).toBeNull();
      expect(result.reason).toBeNull();
      expect(result.intermediateMessage).toBeNull();
      expect(result.contextDataUpdate).toBeNull();
    });

    test("deve acionar o fallback regex quando o parser nativo falhar", async () => {
      const mockStructuredModel = {
        invoke: jest.fn<any>().mockRejectedValue(new Error("Parser failed"))
      };

      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
        invoke: jest.fn<any>().mockResolvedValue({
          content: "```json\n{\n  \"greeting\": \"Olá via Fallback!\",\n  \"confidence\": 0.88\n}\n```"
        })
      };

      const result = await invokeStructuredWithFallback(
        mockModel,
        dummySchema,
        [new HumanMessage("Oi")],
        { name: "TestOutput" }
      );

      expect(result).toEqual({ greeting: "Olá via Fallback!", confidence: 0.88 });
    });

    test("deve processar fallback regex com payload parcial e aplicar defaults nulos", async () => {
      const mockStructuredModel = {
        invoke: jest.fn<any>().mockRejectedValue(new Error("DeepSeek output parser error"))
      };

      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
        invoke: jest.fn<any>().mockResolvedValue({
          content: '```json\n{\n  "nextAgent": "searchAgent",\n  "specialistTask": "Pesquisar previsão do tempo"\n}\n```'
        })
      };

      const result = await invokeStructuredWithFallback(
        mockModel,
        resilientSchema,
        [new HumanMessage("Como está o tempo?")],
        { name: "SupervisorDecision" }
      );

      expect(result.nextAgent).toBe("searchAgent");
      expect(result.specialistTask).toBe("Pesquisar previsão do tempo");
      expect(result.plan).toBeNull();
      expect(result.response).toBeNull();
      expect(result.reason).toBeNull();
    });

    test("deve lançar erro se o fallback também falhar", async () => {
      const mockStructuredModel = {
        invoke: jest.fn<any>().mockRejectedValue(new Error("Parser failed"))
      };

      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
        invoke: jest.fn<any>().mockResolvedValue({
          content: "Resposta sem nenhum JSON válido"
        })
      };

      await expect(
        invokeStructuredWithFallback(
          mockModel,
          dummySchema,
          [new HumanMessage("Oi")],
          { name: "TestOutput" }
        )
      ).rejects.toThrow();
    });

    test("deve recuperar diretamente quando o erro contiver argumentos com sintaxe corrompida (: ,)", async () => {
      const errorMsg = 'Function "TestOutput" arguments:\n\n{"greeting": "Olá direto!", "confidence": 0.99, "extra": , }\n\nare not valid JSON.';
      const mockStructuredModel = {
        invoke: jest.fn<any>().mockRejectedValue(new Error(errorMsg))
      };

      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
        invoke: jest.fn<any>()
      };

      const result = await invokeStructuredWithFallback(
        mockModel,
        dummySchema,
        [new HumanMessage("Oi")],
        { name: "TestOutput" }
      );

      expect(result).toEqual({ greeting: "Olá direto!", confidence: 0.99 });
      // Não deve chamar o LLM novamente pois recuperou direto
      expect(mockModel.invoke).not.toHaveBeenCalled();
    });

    test("deve recuperar diretamente quando o erro contiver argumentos parciais em firstError.message", async () => {
      const errorMsg = 'Failed to parse tool call: {"nextAgent": "FINISH", "response": "Tudo pronto!"}';
      const mockStructuredModel = {
        invoke: jest.fn<any>().mockRejectedValue(new Error(errorMsg))
      };

      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
        invoke: jest.fn<any>()
      };

      const result = await invokeStructuredWithFallback(
        mockModel,
        resilientSchema,
        [new HumanMessage("Oi")],
        { name: "SupervisorDecision" }
      );

      expect(result.nextAgent).toBe("FINISH");
      expect(result.response).toBe("Tudo pronto!");
      expect(result.plan).toBeNull();
      expect(mockModel.invoke).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Pilar 2: Testes do normalizador (Layer 4) — fieldAliases, object→string, scalar→array
    // -------------------------------------------------------------------------

    test("deve aplicar fieldAliases para remapear chave alternativa no fallback", async () => {
      const consolidationSchema = z.object({
        consolidatedMarkdown: z.string(),
        purgeIds: z.array(z.number()).default([]),
        demoteIds: z.array(z.object({ id: z.number(), newImportance: z.number().nullable().default(null) })).default([])
      });

      const mockStructuredModel = {
        invoke: jest.fn<any>().mockRejectedValue(new Error("Parser failed"))
      };

      // LLM retorna "snapshot" ao invés de "consolidatedMarkdown"
      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
        invoke: jest.fn<any>().mockResolvedValue({
          content: '{"snapshot": "## Perfil\nLuiz, 35 anos.", "purgeIds": [], "demoteIds": []}'
        })
      };

      const result = await invokeStructuredWithFallback(
        mockModel,
        consolidationSchema,
        [new HumanMessage("Consolide")],
        {
          name: "MemoryConsolidatorSleep",
          fieldAliases: {
            consolidatedMarkdown: ["snapshot", "markdown", "content"]
          }
        }
      );

      expect(result.consolidatedMarkdown).toBe("## Perfil\nLuiz, 35 anos.");
      expect(result.purgeIds).toEqual([]);
    });

    test("deve converter objeto para Markdown quando o schema espera string (Layer 4)", async () => {
      const singleStringSchema = z.object({
        consolidatedMarkdown: z.string(),
      });

      const mockStructuredModel = {
        invoke: jest.fn<any>().mockRejectedValue(new Error("Parser failed"))
      };

      // LLM retorna objeto hierárquico onde o schema espera string
      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
        invoke: jest.fn<any>().mockResolvedValue({
          content: '{"consolidatedMarkdown": {"perfil": {"nome": "Luiz"}, "hobbies": ["corrida"]}}'
        })
      };

      const result = await invokeStructuredWithFallback(
        mockModel,
        singleStringSchema,
        [new HumanMessage("Consolide")],
        { name: "TestConsolidation" }
      );

      expect(typeof result.consolidatedMarkdown).toBe("string");
      expect(result.consolidatedMarkdown).toContain("PERFIL");
    });

    test("deve normalizar scalar para array quando o schema espera array (Layer 4)", async () => {
      const arraySchema = z.object({
        ids: z.array(z.number()).default([]),
        name: z.string()
      });

      const mockStructuredModel = {
        invoke: jest.fn<any>().mockRejectedValue(new Error("Parser failed"))
      };

      // LLM retorna número único onde o schema espera array
      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
        invoke: jest.fn<any>().mockResolvedValue({
          content: '{"ids": 42, "name": "Luiz"}'
        })
      };

      const result = await invokeStructuredWithFallback(
        mockModel,
        arraySchema,
        [new HumanMessage("Teste")],
        { name: "TestArray" }
      );

      expect(Array.isArray(result.ids)).toBe(true);
      expect(result.ids).toEqual([42]);
    });

    test("fallback prompt deve conter o nome do schema e assinatura de campos", async () => {
      const targetSchema = z.object({
        consolidatedMarkdown: z.string().describe("Snapshot consolidado em Markdown"),
        purgeIds: z.array(z.number()).default([]).describe("IDs a expurgar")
      });

      let capturedFallbackMessages: any[] = [];

      const mockStructuredModel = {
        invoke: jest.fn<any>().mockRejectedValue(new Error("Parser failed"))
      };

      const mockModel = {
        withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
        invoke: jest.fn<any>().mockImplementation((messages: any) => {
          capturedFallbackMessages = messages;
          return Promise.resolve({
            content: '{"consolidatedMarkdown": "## Teste", "purgeIds": []}'
          });
        })
      };

      await invokeStructuredWithFallback(
        mockModel,
        targetSchema,
        [new HumanMessage("Consolide")],
        { name: "MemoryConsolidatorSleep" }
      );

      const fallbackMsg = capturedFallbackMessages[capturedFallbackMessages.length - 1];
      expect(fallbackMsg.content).toContain("MemoryConsolidatorSleep");
      expect(fallbackMsg.content).toContain("consolidatedMarkdown");
      expect(fallbackMsg.content).toContain("purgeIds");
    });
  });
});
