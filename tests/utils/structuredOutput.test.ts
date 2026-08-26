import { jest, describe, test, expect } from '@jest/globals';
import { z } from "zod";
import { invokeStructuredWithFallback } from "../../src/utils/structuredOutput.js";
import { HumanMessage } from "@langchain/core/messages";

describe("Structured Output Fallback Utility", () => {
  const dummySchema = z.object({
    greeting: z.string(),
    confidence: z.number()
  });

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

  test("deve sanitizar vírgulas extras e valores vazios no fallback regex", async () => {
    const mockStructuredModel = {
      invoke: jest.fn<any>().mockRejectedValue(new Error("Generic parser error"))
    };

    const mockModel = {
      withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
      invoke: jest.fn<any>().mockResolvedValue({
        content: '{"greeting": "Recuperado!", "confidence": 0.77, }'
      })
    };

    const result = await invokeStructuredWithFallback(
      mockModel,
      dummySchema,
      [new HumanMessage("Oi")],
      { name: "TestOutput" }
    );

    expect(result).toEqual({ greeting: "Recuperado!", confidence: 0.77 });
  });
});
