import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

dotenv.config();

let aiInstance: any = null;

export function setAIClient(client: any): void {
  aiInstance = client;
}

function getAIClient(): any {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      logger.warn('[EMBEDDINGS] GEMINI_API_KEY não definida nas variáveis de ambiente.');
    }
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

/**
 * Gera um vetor de embedding de 768 dimensões para o texto fornecido usando gemini-embedding-001.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  if (!text || !text.trim()) {
    throw new Error('Texto vazio fornecido para geração de embedding.');
  }

  try {
    const ai = getAIClient();
    const response = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: text.trim()
    });

    const values = response?.embeddings?.[0]?.values;
    if (!values || !Array.isArray(values) || values.length === 0) {
      throw new Error('Formato de resposta inválido da API de embedding.');
    }

    return new Float32Array(values);
  } catch (error: any) {
    logger.error('[EMBEDDINGS ERROR] Falha ao gerar embedding:', error);
    throw error;
  }
}
