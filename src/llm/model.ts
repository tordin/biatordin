import { ChatDeepSeek } from "@langchain/deepseek";
import dotenv from "dotenv";
import { loggerCallbackHandler } from "../utils/logger.js";

dotenv.config();

const deepseekApiKey = process.env.DEEPSEEK_API_KEY || 'sk-e1550dbbc57f43f5b06d0d80451b7f26';
if (!process.env.DEEPSEEK_API_KEY) {
  console.warn("WARNING: DEEPSEEK_API_KEY environment variable is not defined. Using fallback key.");
}

// Flash: Rápido e custo-eficiente para volume
export const modelFlash = new ChatDeepSeek({
  apiKey: deepseekApiKey,
  model: "deepseek-v4-flash",
  temperature: 0.7,
  callbacks: [loggerCallbackHandler],
  modelKwargs: {
    thinking: {
      type: "enabled",
      budget_tokens: 4096
    }
  }
});

// Pro: Alta precisão para planejamento, tool-calling e memória
export const modelPro = new ChatDeepSeek({
  apiKey: deepseekApiKey,
  model: "deepseek-v4-pro",
  temperature: 0.2, // Temperatura mais baixa para respostas mais determinísticas (melhor para JSON/ferramentas)
  callbacks: [loggerCallbackHandler],
  modelKwargs: {
    thinking: {
      type: "enabled",
      budget_tokens: 8192
    }
  }
});

