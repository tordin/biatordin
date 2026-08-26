import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { getSkill } from "../skills/registry.js";
import {
  saveFollowUp,
  getFollowUps,
  getFollowUpById,
  resolveFollowUp,
  cancelFollowUp,
  updateFollowUp,
  FollowUpType,
  FollowUpStatus
} from "../memory/followUps.js";

function formatPhoneToJid(phone?: string): string | undefined {
  if (!phone) return undefined;
  if (phone.includes('@g.us') || phone.includes('@lid') || phone.includes('@s.whatsapp.net')) {
    return phone;
  }
  let clean = phone.replace(/\D/g, '');
  if (!clean.startsWith('55') && clean.length <= 11) {
    clean = '55' + clean;
  }
  if (!clean.endsWith('@s.whatsapp.net')) {
    clean = clean + '@s.whatsapp.net';
  }
  return clean;
}

export const addFollowUpTool = tool(
  async ({ type, contactName, contactNumber, description, dueDate, notes }, config) => {
    const threadId = config?.configurable?.thread_id;
    const chatJid = config?.configurable?.contextData?.chatJid;

    try {
      let resolvedJid = formatPhoneToJid(contactNumber);
      let effectiveContactName = contactName;

      // Se não passou número, tenta resolver via CRM de Entidades
      if (!resolvedJid && contactName) {
        try {
          const { resolveContactJidOrPhone } = await import('../services/entityResolver.js');
          const resolved = await resolveContactJidOrPhone(contactName);
          if (resolved) {
            resolvedJid = resolved.jid || (resolved.phone ? (resolved.phone.startsWith('55') ? `${resolved.phone}@s.whatsapp.net` : `55${resolved.phone}@s.whatsapp.net`) : undefined);
            if (resolved.role_or_relation) {
              effectiveContactName = `${resolved.name} (${resolved.role_or_relation})`;
            } else {
              effectiveContactName = resolved.name;
            }
          }
        } catch (err) {
          logger.debug('[FOLLOWUP AGENT] Erro ao resolver entidade no CRM:', err);
        }
      }

      const followUp = await saveFollowUp({
        type: type as FollowUpType,
        contactName: effectiveContactName,
        contactJid: resolvedJid || null,
        description,
        dueDate: dueDate || null,
        status: 'pending',
        contextOrigin: chatJid ? 'chat_jid' : 'direct',
        chatJid: chatJid || null,
        notes: notes || null,
      });

      const typeLabel = type === 'waiting_for_them' ? 'Waiting for Reply (Aguardando retorno)' : 'Promised by Me (Promessa do Luiz)';
      return `✅ Pendência de Follow-Up registrada com sucesso!\nID: ${followUp.id}\nTipo: ${typeLabel}\nContato: ${followUp.contactName}${resolvedJid ? ` (${resolvedJid})` : ''}\nDescrição: ${followUp.description}${followUp.dueDate ? `\nPrazo: ${followUp.dueDate}` : ''}`;
    } catch (err: any) {
      logger.error("Erro ao registrar follow-up:", err);
      return `Erro ao salvar pendência de follow-up: ${err.message}`;
    }
  },
  {
    name: "add_follow_up",
    description: "Registra uma nova pendência de follow-up. Permite registrar tanto cobranças de terceiros (waiting_for_them) quanto promessas feitas pelo Luiz (promised_by_me).",
    schema: z.object({
      type: z.enum(["waiting_for_them", "promised_by_me"]).describe("Tipo da pendência: 'waiting_for_them' se alguém ficou de entregar/responder algo ao Luiz, ou 'promised_by_me' se o Luiz prometeu entregar algo a alguém."),
      contactName: z.string().describe("Nome do contato, prestador, cliente ou empresa envolvida (ex: 'Marcos', 'João', 'Marcenaria')."),
      contactNumber: z.string().optional().describe("Número de telefone ou JID do contato se disponível (ex: '19999999999')."),
      description: z.string().describe("Descrição clara e objetiva do que foi combinado ou está pendente (ex: 'Enviar proposta revisada da piscina', 'Passar o orçamento até quarta')."),
      dueDate: z.string().optional().describe("Data e hora limite em formato ISO (ex: '2026-08-25T15:00:00Z' ou '2026-08-26')."),
      notes: z.string().optional().describe("Anotações adicionais de contexto sobre a combinação.")
    })
  }
);

export const listFollowUpsTool = tool(
  async ({ type, status, contactName }, config) => {
    try {
      const filterStatus = status || 'active';
      const followUps = await getFollowUps({
        type: (type === 'all' ? undefined : type) as any,
        status: (filterStatus === 'all' ? undefined : filterStatus) as any,
        contactName: contactName || undefined
      });

      if (followUps.length === 0) {
        let msg = "Nenhuma pendência de follow-up encontrada";
        if (type && type !== 'all') {
          msg += ` do tipo '${type === 'waiting_for_them' ? 'Waiting for Reply' : 'Promised by Me'}'`;
        }
        if (contactName) {
          msg += ` para o contato '${contactName}'`;
        }
        return msg + ".";
      }

      const formatted = followUps.map(f => {
        const typeTag = f.type === 'waiting_for_them' ? '⏳ [Aguardando Terceiro]' : '🤝 [Prometido pelo Luiz]';
        const statusTag = f.status === 'resolved' ? '✅ Resolvido' : f.status === 'cancelled' ? '❌ Cancelado' : f.status === 'overdue' ? '⚠️ VENCIDO' : '🕒 Pendente';
        const due = f.dueDate ? ` | Prazo: ${f.dueDate}` : '';
        const notesStr = f.notes ? ` | Obs: ${f.notes}` : '';
        return `- [ID ${f.id}] ${typeTag} ${statusTag} | Contato: ${f.contactName} | "${f.description}"${due}${notesStr}`;
      }).join("\n");

      return `<RAW_TOOL_OUTPUT source="sqlite:followups">\nLista de Pendências de Follow-Up:\n${formatted}\n</RAW_TOOL_OUTPUT>`;
    } catch (err: any) {
      logger.error("Erro ao listar follow-ups:", err);
      return `Erro ao consultar pendências no banco de dados: ${err.message}`;
    }
  },
  {
    name: "list_follow_ups",
    description: "Lista as pendências de follow-up cadastradas. Permite filtrar por tipo ('waiting_for_them', 'promised_by_me', 'all'), por status ('active', 'pending', 'overdue', 'resolved', 'cancelled', 'all') e por nome do contato.",
    schema: z.object({
      type: z.enum(["waiting_for_them", "promised_by_me", "all"]).optional().describe("Filtrar por tipo: 'waiting_for_them' (aguardando retorno de terceiros), 'promised_by_me' (compromissos assumidos pelo Luiz) ou 'all'."),
      status: z.enum(["active", "pending", "overdue", "resolved", "cancelled", "all"]).optional().describe("Filtrar por status. Padrão: 'active' (inclui pendentes e vencidas)."),
      contactName: z.string().optional().describe("Filtrar por nome do contato.")
    })
  }
);

export const resolveFollowUpTool = tool(
  async ({ id, contactName, notes }, config) => {
    try {
      if (id) {
        const item = await getFollowUpById(id);
        if (!item) {
          return `Pendência ID ${id} não foi encontrada.`;
        }
        const ok = await resolveFollowUp(id, notes);
        if (ok) {
          return `✅ Pendência ID ${id} (${item.contactName} - "${item.description}") foi marcada como resolvida com sucesso!`;
        } else {
          return `Pendência ID ${id} já estava resolvida.`;
        }
      }

      if (contactName) {
        const active = await getFollowUps({ status: 'active', contactName });
        if (active.length === 0) {
          return `Nenhuma pendência ativa encontrada para o contato '${contactName}'.`;
        }
        if (active.length === 1) {
          const item = active[0];
          await resolveFollowUp(item.id, notes || `Resolvido via comando para ${contactName}`);
          return `✅ Pendência ID ${item.id} de '${item.contactName}' ("${item.description}") foi marcada como resolvida!`;
        }
        // Multiple matches
        const listStr = active.map(a => `ID ${a.id}: "${a.description}"`).join(", ");
        return `Foram encontradas múltiplas pendências ativas para '${contactName}': [${listStr}]. Especifique o ID exato para resolver.`;
      }

      return "Informe o ID numérico ou o nome do contato para resolver a pendência.";
    } catch (err: any) {
      logger.error("Erro ao resolver follow-up:", err);
      return `Erro ao dar baixa na pendência: ${err.message}`;
    }
  },
  {
    name: "resolve_follow_up",
    description: "Dá baixa (marca como resolvida) em uma pendência de follow-up pelo ID numérico ou pelo nome do contato quando o retorno for recebido ou o compromisso for cumprido.",
    schema: z.object({
      id: z.number().optional().describe("O ID numérico da pendência a ser resolvida."),
      contactName: z.string().optional().describe("Opcional: nome do contato para resolver a pendência se não souber o ID."),
      notes: z.string().optional().describe("Observação ou desfecho opcional da resolução.")
    })
  }
);

export const cancelFollowUpTool = tool(
  async ({ id, notes }, config) => {
    try {
      const item = await getFollowUpById(id);
      if (!item) {
        return `Pendência ID ${id} não foi encontrada.`;
      }
      const ok = await cancelFollowUp(id, notes);
      if (ok) {
        return `❌ Pendência ID ${id} (${item.contactName} - "${item.description}") foi cancelada com sucesso.`;
      } else {
        return `Pendência ID ${id} já estava cancelada.`;
      }
    } catch (err: any) {
      logger.error("Erro ao cancelar follow-up:", err);
      return `Erro ao cancelar pendência: ${err.message}`;
    }
  },
  {
    name: "cancel_follow_up",
    description: "Cancela uma pendência de follow-up pelo seu ID numérico.",
    schema: z.object({
      id: z.number().describe("O ID numérico da pendência a ser cancelada."),
      notes: z.string().optional().describe("Motivo do cancelamento.")
    })
  }
);

export const updateFollowUpTool = tool(
  async ({ id, dueDate, notes }, config) => {
    try {
      const item = await getFollowUpById(id);
      if (!item) {
        return `Pendência ID ${id} não foi encontrada.`;
      }
      const ok = await updateFollowUp(id, {
        dueDate: dueDate !== undefined ? dueDate : undefined,
        notes: notes !== undefined ? (item.notes ? `${item.notes}\n${notes}` : notes) : undefined
      });

      if (ok) {
        return `✅ Pendência ID ${id} atualizada com sucesso!${dueDate ? ` Novo prazo: ${dueDate}` : ''}`;
      } else {
        return `Nenhuma alteração foi realizada na pendência ID ${id}.`;
      }
    } catch (err: any) {
      logger.error("Erro ao atualizar follow-up:", err);
      return `Erro ao atualizar pendência: ${err.message}`;
    }
  },
  {
    name: "update_follow_up",
    description: "Atualiza o prazo de vencimento (dueDate) ou adiciona observações em uma pendência existente pelo seu ID.",
    schema: z.object({
      id: z.number().describe("O ID numérico da pendência a ser atualizada."),
      dueDate: z.string().optional().describe("Nova data e hora limite em formato ISO (ex: '2026-08-30T18:00:00Z')."),
      notes: z.string().optional().describe("Novas observações a serem acrescentadas à pendência.")
    })
  }
);

const FOLLOWUP_PROMPT = getSkill("followUpAgent")?.detailedPrompt ||
  "Você é o Agente de Gestão de Follow-Up e Cobranças da Bia.\n" +
  "Sua função é gerenciar pendências de 'waiting_for_them' e 'promised_by_me'.\n" +
  "Sempre use as ferramentas apropriadas e retorne os dados com clareza.";

const followUpAgent = createReactAgent({
  llm: model,
  tools: [addFollowUpTool, listFollowUpsTool, resolveFollowUpTool, cancelFollowUpTool, updateFollowUpTool],
  messageModifier: FOLLOWUP_PROMPT,
});

export async function followUpAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("followUpAgent", () => followUpAgent, state, undefined, config);
}
