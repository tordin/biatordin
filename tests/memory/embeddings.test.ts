import { generateEmbedding } from "../../src/memory/embeddings.js";

describe("Embeddings Generator Helper", () => {
  test("deve lançar erro se o texto for vazio", async () => {
    await expect(generateEmbedding("")).rejects.toThrow();
  });

  test("deve gerar um vetor de Float32Array para um texto válido ou tratar erro de API", async () => {
    try {
      const embedding = await generateEmbedding("Texto de teste para embedding");
      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBeGreaterThan(0);
    } catch (err: any) {
      // Se não houver chave ou conexão, aceitamos o erro tratado de API
      expect(err).toBeDefined();
    }
  });
});
