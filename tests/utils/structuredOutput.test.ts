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
        invoke: jest.fn().mockResolvedValue({ greeting: "Olá!", confidence: 0.95 })
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
      invoke: jest.fn().mockRejectedValue(new Error("Parser failed"))
    };

    const mockModel = {
      withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
      invoke: jest.fn().mockResolvedValue({
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
      invoke: jest.fn().mockRejectedValue(new Error("Parser failed"))
    };

    const mockModel = {
      withStructuredOutput: jest.fn().mockReturnValue(mockStructuredModel),
      invoke: jest.fn().mockResolvedValue({
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
});
