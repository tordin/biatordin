import { GoogleGenAI } from "@google/genai";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import dotenv from "dotenv";
import { loggerCallbackHandler } from "../utils/logger.js";

dotenv.config();

const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
if (!deepseekApiKey) {
  console.warn("WARNING: DEEPSEEK_API_KEY environment variable is not defined.");
}

const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  console.warn("WARNING: OPENAI_API_KEY environment variable is not defined.");
}

export const googleGenAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// Supervisor Ativo: gpt-5-nano com Strict Structured Outputs
// NOTA: gpt-5-nano só suporta a temperatura default (1), valores customizados como 0.1 causam HTTP 400.
export const modelSupervisorActive = new ChatOpenAI({
  apiKey: openaiApiKey,
  model: "gpt-5-nano",
  callbacks: [loggerCallbackHandler],
});

// Semantic Arbiter: gpt-5-nano
export const modelSemanticArbiter = new ChatOpenAI({
  apiKey: openaiApiKey,
  model: "gpt-5-nano",
  callbacks: [loggerCallbackHandler],
});

// Memory Consolidator: gemini-3.1-pro-preview
export const modelMemoryConsolidator = new ChatGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_API_KEY,
  model: "gemini-3.1-pro-preview",
  temperature: 0.2,
  callbacks: [loggerCallbackHandler],
});

// Flash: Rápido e custo-eficiente para volume
// SEMPRE sem thinking — thinking é exclusivo do reasoningAgent (modelPro)
export const modelFlash = new ChatDeepSeek({
  apiKey: deepseekApiKey,
  model: "deepseek-v4-flash",
  temperature: 0.3, // Reduzido de 0.7 para extração factual e uso de ferramentas — minimiza alucinações
  callbacks: [loggerCallbackHandler],
  modelKwargs: {
    thinking: {
      type: "disabled"
    }
  }
});

// Flash Structured: Mesmo modelo, com thinking mode EXPLICITAMENTE desabilitado
// porque a API do DeepSeek ativa thinking por padrão em alguns modelos,
// e thinking mode é incompatível com tool_choice (usado pelo withStructuredOutput).
export const modelFlashStructured = new ChatDeepSeek({
  apiKey: deepseekApiKey,
  model: "deepseek-v4-flash",
  temperature: 0.1, // Reduzido de 0.7 para decisões de roteamento quase-determinísticas da supervisora
  callbacks: [loggerCallbackHandler],
  configuration: {
    baseURL: "https://api.deepseek.com/beta"
  },
  modelKwargs: {
    thinking: {
      type: "disabled"
    }
  }
});

// Pro: Mantido para compatibilidade, agora usando deepseek-v4-flash
export const modelPro = new ChatDeepSeek({
  apiKey: deepseekApiKey,
  model: "deepseek-v4-flash",
  temperature: 0.2, // Temperatura mais baixa para respostas mais determinísticas (melhor para JSON/ferramentas)
  callbacks: [loggerCallbackHandler],
  modelKwargs: {
    thinking: {
      type: "enabled",
      budget_tokens: 8192
    }
  }
});

// Pro Structured: Mantido para compatibilidade, agora usando deepseek-v4-flash
export const modelProStructured = new ChatDeepSeek({
  apiKey: deepseekApiKey,
  model: "deepseek-v4-flash",
  temperature: 0.2,
  callbacks: [loggerCallbackHandler],
  configuration: {
    baseURL: "https://api.deepseek.com/beta"
  },
  modelKwargs: {
    thinking: {
      type: "disabled"
    }
  }
});

