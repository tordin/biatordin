import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { getSkill } from "../skills/registry.js";

interface OpenMeteoResponse {
  current?: {
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    wind_speed_10m_max: number[];
  };
}

const WEATHER_CODES: Record<number, string> = {
  0: "Céu limpo",
  1: "Principalmente limpo",
  2: "Parcialmente nublado",
  3: "Encoberto",
  45: "Nevoeiro",
  48: "Névoa gelada",
  51: "Garoa fraca",
  53: "Garoa moderada",
  55: "Garoa intensa",
  56: "Garoa congelante fraca",
  57: "Garoa congelante intensa",
  61: "Chuva fraca",
  63: "Chuva moderada",
  65: "Chuva intensa",
  66: "Chuva congelante fraca",
  67: "Chuva congelante intensa",
  71: "Neve fraca",
  73: "Neve moderada",
  75: "Neve intensa",
  77: "Grãos de neve",
  80: "Pancadas de chuva fracas",
  81: "Pancadas de chuva moderadas",
  82: "Pancadas de chuva violentas",
  85: "Pancadas de neve fracas",
  86: "Pancadas de neve intensas",
  95: "Tempestade",
  96: "Tempestade com granizo fraco",
  99: "Tempestade com granizo forte",
};

function formatWeatherResponse(data: OpenMeteoResponse, cityName: string): string {
  const parts: string[] = [];
  
  if (data.current) {
    const c = data.current;
    const condition = WEATHER_CODES[c.weather_code] || `Código ${c.weather_code}`;
    parts.push(`📍 *${cityName}* — Agora`);
    parts.push(`${condition}`);
    parts.push(`🌡️ ${c.temperature_2m.toFixed(1)}°C (sensação ${c.apparent_temperature.toFixed(1)}°C)`);
    parts.push(`💧 Umidade: ${c.relative_humidity_2m}% | 💨 Vento: ${c.wind_speed_10m.toFixed(1)} km/h`);
  }
  
  if (data.daily) {
    parts.push(``);
    parts.push(`📅 *Próximos dias*`);
    for (let i = 0; i < data.daily.time.length; i++) {
      const date = new Date(data.daily.time[i] + "T12:00:00");
      const dayName = date.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" });
      const condition = WEATHER_CODES[data.daily.weather_code[i]] || `Código ${data.daily.weather_code[i]}`;
      const max = data.daily.temperature_2m_max[i].toFixed(1);
      const min = data.daily.temperature_2m_min[i].toFixed(1);
      const rain = data.daily.precipitation_probability_max[i];
      const wind = data.daily.wind_speed_10m_max[i].toFixed(1);
      parts.push(`${dayName}: ${condition}, ${min}°C~${max}°C, 🌧️${rain}% 💨${wind}km/h`);
    }
  }
  
  return parts.join("\n");
}

const weatherTool = tool(
  async ({ latitude, longitude, cityName }) => {
    logger.info(`[WEATHER] Consultando OpenMeteo para ${cityName} (${latitude}, ${longitude})`);
    
    const params = new URLSearchParams({
      latitude: latitude.toString(),
      longitude: longitude.toString(),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
      timezone: "auto",
      forecast_days: "5",
    });

    try {
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
        signal: AbortSignal.timeout(8000),
      });
      
      if (!response.ok) {
        return `Erro ao consultar clima: ${response.status} ${response.statusText}`;
      }
      
      const data: OpenMeteoResponse = await response.json();
      
      if (!data.current && !data.daily) {
        return "Não foi possível obter dados meteorológicos para esta localização.";
      }
      
      return formatWeatherResponse(data, cityName);
    } catch (err) {
      logger.error("[WEATHER] Erro ao consultar OpenMeteo:", err);
      return `Erro ao consultar a previsão do tempo: ${(err as Error).message}`;
    }
  },
  {
    name: "get_weather",
    description: "Obtém a previsão do tempo atual e para os próximos 5 dias para uma cidade. Use quando o usuário perguntar sobre clima, temperatura, previsão do tempo, se vai chover, etc.",
    schema: z.object({
      latitude: z.number().describe("Latitude da cidade (ex: -23.5505 para São Paulo)"),
      longitude: z.number().describe("Longitude da cidade (ex: -46.6333 para São Paulo)"),
      cityName: z.string().describe("Nome da cidade para exibir na resposta (ex: 'São Paulo', 'Campinas')"),
    }),
  }
);

const WEATHER_PROMPT = getSkill("weatherAgent")?.detailedPrompt || "";

const weatherAgent = createReactAgent({
  llm: model,
  tools: [weatherTool],
  messageModifier: WEATHER_PROMPT,
});

export async function weatherAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("weatherAgent", () => weatherAgent, state, undefined, config);
}
