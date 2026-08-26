import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenAI } from "@langchain/openai";
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

// Supervisor Ativo: gpt-4o-mini com Strict Structured Outputs e fluidez conversacional
export const modelSupervisorActive = new ChatOpenAI({
  apiKey: openaiApiKey,
  model: "gpt-4o-mini",
  temperature: 0.1,
  callbacks: [loggerCallbackHandler],
});

// Evaluator / Critic: gpt-4o-mini com temperature 0.0 para modo estritamente analítico e determinístico
export const modelEvaluator = new ChatOpenAI({
  apiKey: openaiApiKey,
  model: "gpt-4o-mini",
  temperature: 0.0,
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

