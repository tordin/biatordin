import { jest, describe, test, expect } from '@jest/globals';
import { z } from "zod";
import { invokeStructuredWithFallback, extractAndParseJson } from "../../src/utils/structuredOutput.js";
import { HumanMessage } from "@langchain/core/messages";

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
  });
});
