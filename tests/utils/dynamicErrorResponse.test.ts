import { jest } from "@jest/globals";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { generateDynamicErrorResponse, HARDCODED_CONNECTION_ERROR_MSG } from "../../src/utils/dynamicErrorResponse.js";
import { modelFlash } from "../../src/llm/model.js";

describe("generateDynamicErrorResponse", () => {
  it("should generate a dynamic response from LLM when LLM call succeeds", async () => {
    jest.spyOn(modelFlash, "invoke").mockResolvedValueOnce(
      new AIMessage("Desculpe, tive um problema ao acessar a API de finanças.") as any
    );

    const response = await generateDynamicErrorResponse({
      messages: [new HumanMessage("Qual a cotação do dólar?")],
      problemDescription: "Falha ao acessar API externa de finanças."
    });

    expect(response).toBeDefined();
    expect(typeof response).toBe("string");
    expect(response.length).toBeGreaterThan(5);
    expect(response).toContain("API de finanças");
  });

  it("should fallback to the single hardcoded message if LLM invoke throws", async () => {
    const spy = jest.spyOn(modelFlash, "invoke").mockImplementationOnce(() => {
      throw new Error("Network connection error");
    });

    const response = await generateDynamicErrorResponse({
      messages: [new HumanMessage("Oi")],
      problemDescription: "Erro simulado"
    });

    expect(response).toBe(HARDCODED_CONNECTION_ERROR_MSG);
    spy.mockRestore();
  });
});
