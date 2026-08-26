import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import {
  addSentinelRule,
  getSentinelRules,
  deleteSentinelRule,
  getSentinelStats,
  getRecentProcessedEmails,
} from "../memory/emailSentinel.js";
import { runSentinelScan } from "../services/emailSentinel/sentinelService.js";
import { checkGoogleAuthStatus } from "../services/emailSentinel/gmailFetcher.js";
import { getSkill } from "../skills/registry.js";

export const addSentinelRuleTool = tool(
  async ({ type, pattern, target, reason }, config) => {
    try {
      const rule = await addSentinelRule(type, pattern, target || 'general', reason);
      const typeLabel = type === 'ignore' ? '🚫 Descarte (Ignorar)' : '⭐ Prioridade Alta';
      return `Regra do Sentinela cadastrada com sucesso! [ID: ${rule.id}] Tipo: ${typeLabel} | Padrão: "${rule.pattern}" | Alvo: ${rule.target}${reason ? ` | Motivo: "${reason}"` : ""}`;
    } catch (err: any) {
      logger.error("[EMAIL_SENTINEL_AGENT] Erro ao adicionar regra:", err);
      return `Erro ao cadastrar regra do sentinela: ${err.message}`;
    }
  },
  {
    name: "add_sentinel_rule",
    description: "Adiciona uma nova regra de monitoramento para o Sentinela de E-mails do Gmail. Use 'ignore' para descartar/nunca avisar sobre remetentes/lojas/assuntos específicos, ou 'priority' para remetentes/assuntos importantes (ex: escola, condomínio, clientes) que sempre devem gerar alerta.",
    schema: z.object({
      type: z.enum(["ignore", "priority"]).describe("Tipo da regra: 'ignore' (descartar e nunca alertar) ou 'priority' (sempre considerar prioridade e alertar)."),
      pattern: z.string().describe("O termo, nome da loja/empresa, e-mail, domínio ou assunto a ser monitorado (ex: 'Submarino', 'escola da Cecília', 'condomínio', 'boleto')."),
      target: z.enum(["sender", "domain", "subject", "general"]).optional().describe("Campo onde aplicar a regra: 'sender', 'domain', 'subject' ou 'general' (padrão)."),
      reason: z.string().optional().describe("Motivo ou anotação explicativa da regra.")
    })
  }
);

export const listSentinelRulesTool = tool(
  async ({ typeFilter }, config) => {
    try {
      const rules = await getSentinelRules(typeFilter);
      if (rules.length === 0) {
        return "Nenhuma regra cadastrada no Sentinela de E-mails.";
      }

      const formatted = rules.map(r => {
        const icon = r.type === 'ignore' ? '🚫' : '⭐';
        return `- [ID: ${r.id}] ${icon} [${r.type.toUpperCase()}] "${r.pattern}" (${r.target})${r.reason ? ` - ${r.reason}` : ""}`;
      }).join("\n");

      return `<RAW_TOOL_OUTPUT source="sqlite:email_sentinel_rules">\nRegras do Sentinela de E-mails:\n${formatted}\n</RAW_TOOL_OUTPUT>`;
    } catch (err: any) {
      logger.error("[EMAIL_SENTINEL_AGENT] Erro ao listar regras:", err);
      return `Erro ao listar regras do sentinela: ${err.message}`;
    }
  },
  {
    name: "list_sentinel_rules",
    description: "Lista todas as regras de prioridade e descarte ativas do Sentinela de E-mails.",
    schema: z.object({
      typeFilter: z.enum(["ignore", "priority", "learning"]).optional().describe("Filtro opcional pelo tipo de regra ('ignore', 'priority' ou 'learning').")
    })
  }
);

export const deleteSentinelRuleTool = tool(
  async ({ id }, config) => {
    try {
      const success = await deleteSentinelRule(id);
      if (success) {
        return `Regra ID ${id} do Sentinela de E-mails foi excluída com sucesso.`;
      }
      return `Regra ID ${id} não encontrada no banco de dados.`;
    } catch (err: any) {
      logger.error(`[EMAIL_SENTINEL_AGENT] Erro ao excluir regra ${id}:`, err);
      return `Erro ao excluir regra do sentinela: ${err.message}`;
    }
  },
  {
    name: "delete_sentinel_rule",
    description: "Exclui uma regra do Sentinela de E-mails pelo seu ID numérico. Use list_sentinel_rules antes se precisar descobrir o ID.",
    schema: z.object({
      id: z.number().describe("O ID numérico da regra a ser excluída.")
    })
  }
);

export const checkInboxNowTool = tool(
  async ({ maxResults }, config) => {
    try {
      const stats = await runSentinelScan({ maxResults: maxResults || 30 });
      return (
        `Varredura do Sentinela de E-mail concluída!\n` +
        `- Total não lidos avaliados: ${stats.totalUnread}\n` +
        `- Descartados na Etapa 1 (Heurísticas/Regras): ${stats.heuristicFiltered}\n` +
        `- Analisados em lote na Etapa 2 (LLM): ${stats.analyzedWithLLM}\n` +
        `- E-mails importantes identificados: ${stats.importantEmailsCount}\n` +
        `- Alerta enviado no WhatsApp: ${stats.alertSent ? "Sim" : "Não (silêncio / sem novidades críticas)"}`
      );
    } catch (err: any) {
      logger.error("[EMAIL_SENTINEL_AGENT] Erro ao executar varredura sob demanda:", err);
      return `Erro ao executar varredura do sentinela: ${err.message}`;
    }
  },
  {
    name: "check_inbox_now",
    description: "Dispara manualmente uma varredura imediata da caixa de entrada do Gmail usando o fluxo em duas etapas do Sentinela de E-mails.",
    schema: z.object({
      maxResults: z.number().optional().describe("Número máximo opcional de e-mails não lidos para verificar (padrão: 30).")
    })
  }
);

export const getSentinelLogsTool = tool(
  async ({ limit, classification, todayOnly }, config) => {
    try {
      const stats = await getSentinelStats(todayOnly ? new Date().toISOString().split('T')[0] : undefined);
      const logs = await getRecentProcessedEmails(limit || 15, { classification, todayOnly });

      const statsSummary =
        `📊 Estatísticas do Sentinela ${todayOnly ? "(Hoje)" : "(Geral)"}:\n` +
        `• Total de e-mails processados: ${stats.totalProcessed}\n` +
        `• Descartados na Etapa 1 (Heurística/Regras): ${stats.ignoredHeuristic}\n` +
        `• Descartados na Etapa 2 (LLM / Baixa relevância): ${stats.ignoredLlm}\n` +
        `• Identificados como Importantes: ${stats.important}\n` +
        `• Alertas enviados no WhatsApp: ${stats.alerted}\n`;

      if (logs.length === 0) {
        return `${statsSummary}\nNenhum log individual encontrado para os filtros selecionados.`;
      }

      const logList = logs.map(l => {
        const icon = l.classification === 'important' || l.classification === 'alerted' ? '⭐ [IMPORTANTE]' : '🚫 [IGNORADO]';
        return `- ${icon} ${l.sender || "Desconhecido"} — "${l.subject || "(sem assunto)"}"\n  Classificação: ${l.classification} | Motivo: ${l.reason || "N/A"} | Data: ${l.processedAt}`;
      }).join("\n");

      return `<RAW_TOOL_OUTPUT source="sqlite:email_sentinel_log">\n${statsSummary}\nÚltimos e-mails processados:\n${logList}\n</RAW_TOOL_OUTPUT>`;
    } catch (err: any) {
      logger.error("[EMAIL_SENTINEL_AGENT] Erro ao consultar logs do sentinela:", err);
      return `Erro ao consultar logs do sentinela: ${err.message}`;
    }
  },
  {
    name: "get_sentinel_logs",
    description: "Consulta o histórico e as estatísticas de e-mails processados pelo Sentinela (quantos foram processados hoje, quais foram descartados por heurística ou pelo LLM, e quais foram alertados no WhatsApp com seus motivos).",
    schema: z.object({
      limit: z.number().optional().describe("Quantidade máxima de logs a retornar (padrão: 15)."),
      classification: z.enum(["all", "ignored_heuristic", "ignored_llm", "important", "alerted"]).optional().describe("Filtro por classificação."),
      todayOnly: z.boolean().optional().describe("Se true, filtra apenas e-mails processados no dia de hoje.")
    })
  }
);

export const checkGoogleAuthStatusTool = tool(
  async ({}, config) => {
    try {
      const status = await checkGoogleAuthStatus();
      const icon = status.valid ? "✅" : "⚠️";
      return `${icon} Status da Autenticação do Google:\n${status.message}`;
    } catch (err: any) {
      logger.error("[EMAIL_SENTINEL_AGENT] Erro ao verificar status do Google OAuth:", err);
      return `Erro ao testar status da autenticação do Google: ${err.message}`;
    }
  },
  {
    name: "check_google_auth_status",
    description: "Verifica se a autenticação OAuth com a conta Google (Gmail / Workspace) está ativa e válida ou se expirou e precisa ser renovada no .env (GOOGLE_REFRESH_TOKEN).",
    schema: z.object({}),
  }
);

const EMAIL_SENTINEL_PROMPT = getSkill("emailSentinelAgent")?.detailedPrompt ||
  "Você é o Agente Sentinela de E-mail (Inbox Watcher) da Bia.\n" +
  "Sua função principal é gerenciar as regras de filtragem inteligente do Gmail (adicionar regras de ignorar/descartar, adicionar regras de prioridade, listar regras existentes e excluir regras), consultar o histórico/estatísticas de e-mails processados, verificar o status da conexão do Google OAuth e disparar varreduras da caixa de entrada quando solicitado.\n" +
  "Diretrizes:\n" +
  "1. Quando o usuário ensinar uma regra de descarte (ex: 'nunca mais me avise de e-mails da loja X', 'ignore e-mails do remetente Y', 'aquele e-mail que você me avisou não era importante'), use `add_sentinel_rule` com `type: 'ignore'`.\n" +
  "2. Quando o usuário definir uma regra de prioridade (ex: 'e-mails do condomínio ou da escola são sempre prioridade'), use `add_sentinel_rule` com `type: 'priority'`.\n" +
  "3. Para listar regras, chame `list_sentinel_rules`.\n" +
  "4. Para excluir uma regra pelo ID, chame `delete_sentinel_rule`.\n" +
  "5. Para consultar quantos e-mails foram processados hoje, quais foram ignorados ou alertados, use `get_sentinel_logs`.\n" +
  "6. Para verificar se a conexão/token com o Google está saudável ou expirou, use `check_google_auth_status`.\n" +
  "7. Se o usuário pedir para checar ou varrer os e-mails agora, chame `check_inbox_now`.\n" +
  "8. Sempre retorne o resultado de forma clara e objetiva para a Supervisora.";

const emailSentinelAgent = createReactAgent({
  llm: model,
  tools: [
    addSentinelRuleTool,
    listSentinelRulesTool,
    deleteSentinelRuleTool,
    checkInboxNowTool,
    getSentinelLogsTool,
    checkGoogleAuthStatusTool,
  ],
  messageModifier: EMAIL_SENTINEL_PROMPT,
});

export async function emailSentinelAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("emailSentinelAgent", () => emailSentinelAgent, state, undefined, config);
}
