import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { initWorkspaceTools, safeAgentNode } from "./base.js";
import { modelFlash as model } from "../../llm/model.js";
import { AgentState } from "../state.js";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { google } from "googleapis";

import { getSkill } from "../../skills/registry.js";

const SHEETS_PROMPT = getSkill("sheetsAgent")?.detailedPrompt || "";

const createSpreadsheetTool = tool(
  async ({ title, initialData }) => {
    try {
      const auth = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
      );
      auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      const sheets = google.sheets({ version: "v4", auth });
      
      const res = await sheets.spreadsheets.create({
        requestBody: { properties: { title } }
      });
      
      if (initialData && initialData.length > 0) {
        const sid = res.data.spreadsheetId;
        if (!sid) throw new Error("Falha ao obter o ID da planilha (spreadsheetId)");
        await sheets.spreadsheets.values.update({
          spreadsheetId: sid,
          range: "A1",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: initialData }
        });
      }
      return `Planilha criada com sucesso! ID: ${res.data.spreadsheetId}, URL: ${res.data.spreadsheetUrl}`;
    } catch (e: any) {
      return `Erro ao criar planilha: ${e.message}`;
    }
  },
  {
    name: "create_spreadsheet",
    description: "Cria uma nova planilha do Google (Spreadsheet) e opcionalmente a preenche com dados iniciais.",
    schema: z.object({
      title: z.string().describe("O título da planilha."),
      initialData: z.array(z.array(z.string())).optional().describe("Matriz bidimensional (2D) opcional de strings para dados iniciais (ex: [['Coluna1', 'Coluna2'], ['Valor1', 'Valor2']]).")
    })
  }
);

let sheetsAgent: any = null;

async function initSheetsAgent() {
  if (!sheetsAgent) {
    const tools = await initWorkspaceTools();
    const messageModifier = tools.length > 0 
      ? SHEETS_PROMPT 
      : SHEETS_PROMPT + "\n\nAviso: As ferramentas do MCP falharam ao carregar. (Ferramentas nativas ainda estão disponíveis)";
    
    sheetsAgent = createReactAgent({
      llm: model,
      tools: [createSpreadsheetTool],
      messageModifier,
    });
  }
}

export async function sheetsAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("sheetsAgent", () => sheetsAgent, state, initSheetsAgent, config);
}
