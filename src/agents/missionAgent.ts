import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { getSkill } from "../skills/registry.js";
import { saveMission, getRecentMissionsForMaster, getRecentMissionsByTarget, completeMission, getActiveMissionsForTarget, updateMissionNotes, findActiveMission } from "../memory/missions.js";
import { saveFollowUp, getFollowUps, resolveFollowUp } from "../memory/followUps.js";
import { sendDirectMessage, notifyMaster } from "../transport/whatsapp.js";
import { MASTER_NUMBER } from "../memory/security.js";
import { appendMessageToHistory } from "../memory/chatHistory.js";
import { jidsMatch } from "../utils/jidResolver.js";

// Função auxiliar para formatar número para JID do WhatsApp com resolução de entidades do CRM
async function resolveAndFormatTargetJid(targetInput: string): Promise<{ jid: string; preferences?: Record<string, any>; entityName?: string }> {
    if (targetInput.includes('@g.us') || targetInput.includes('@lid') || targetInput.includes('@s.whatsapp.net')) {
        return { jid: targetInput };
    }
    const cleanDigits = targetInput.replace(/\D/g, '');
    if (cleanDigits.length >= 8) {
        let clean = cleanDigits;
        if (!clean.startsWith('55') && clean.length <= 11) {
            clean = '55' + clean;
        }
        return { jid: clean + '@s.whatsapp.net' };
    }

    // Se não for número puro, tenta resolver via CRM de Entidades
    try {
        const { resolveContactJidOrPhone } = await import('../services/entityResolver.js');
        const resolved = await resolveContactJidOrPhone(targetInput);
        if (resolved) {
            const jid = resolved.jid || (resolved.phone ? (resolved.phone.startsWith('55') ? `${resolved.phone}@s.whatsapp.net` : `55${resolved.phone}@s.whatsapp.net`) : null);
            if (jid) {
                return { jid, preferences: resolved.preferences, entityName: resolved.name };
            }
        }
    } catch (err) {
        logger.debug('[MISSION AGENT] Erro ao resolver entidade no CRM:', err);
    }

    let clean = cleanDigits;
    if (!clean.startsWith('55') && clean.length <= 11) {
        clean = '55' + clean;
    }
    return { jid: (clean || targetInput) + (clean.endsWith('@s.whatsapp.net') ? '' : '@s.whatsapp.net') };
}

export const startMissionTool = tool(
    async ({ targetNumber, objective, firstMessage, ttlHours }, config) => {
        const threadId = config?.configurable?.thread_id;
        if (!threadId) return "Erro: não foi possível identificar o chat do Master.";
        const masterJid = config?.configurable?.contextData?.chatJid;
        if (!masterJid) throw new Error("masterJid (chatJid) is required in contextData");
        const accountName = config?.configurable?.contextData?.accountName || 'main';

        const { jid: targetJid, preferences, entityName } = await resolveAndFormatTargetJid(targetNumber);

        try {
            // Evita missões duplicadas: se já existe missão ATIVA com este alvo, reutiliza
            const existing = await findActiveMission(masterJid, targetJid);
            if (existing) {
                return `⚠️ AVISO: Já existe uma missão ativa (ID: ${existing.id}) com este alvo. O objetivo atual é: "${existing.objective}". Nenhuma nova missão foi criada e NENHUMA mensagem foi enviada agora. Se precisar enviar uma mensagem, use a ferramenta 'send_message_to_target' ou gerencie-a de outra forma.`;
            }

            const mission = await saveMission(masterJid, targetJid, objective, ttlHours);

            // Cria automaticamente pendência de Waiting for Reply para a missão
            const followUpHours = ttlHours || 24;
            const followUpDueDate = new Date(Date.now() + followUpHours * 60 * 60 * 1000).toISOString();
            saveFollowUp({
                type: 'waiting_for_them',
                contactName: entityName || targetJid,
                contactJid: targetJid,
                description: `Retorno da missão: ${objective}`,
                dueDate: followUpDueDate,
                contextOrigin: 'mission_id',
                missionId: mission.id,
                chatJid: targetJid,
                notes: preferences && Object.keys(preferences).length > 0 ? `Preferências do contato: ${JSON.stringify(preferences)}` : null
            }).catch(e => logger.warn('[MISSION AGENT] Falha ao registrar follow-up de missão:', e));
            
            // Envia a primeira mensagem diretamente
            const sent = await sendDirectMessage(accountName, targetJid, firstMessage);
            if (sent) {
                // Registra no histórico do chat do alvo para manter contexto
                appendMessageToHistory(accountName, targetJid, {
                    id: "mission-start-" + Date.now(),
                    timestamp: Date.now(),
                    sender: accountName === 'personal' ? 'personal' : 'main',
                    senderName: "Bia",
                    content: firstMessage,
                    isFromMe: true
                });
            }
            
            if (sent) {
                return `✅ Missão (ID: ${mission.id}) iniciada com sucesso! A mensagem inicial foi agendada para envio para ${targetJid}. Objetivo registrado: "${objective}".`;
            } else {
                return `⚠️ Missão (ID: ${mission.id}) registrada no banco, mas houve falha ao agendar envio para ${targetJid}.`;
            }
        } catch (err: any) {
            logger.error("Erro ao iniciar missão:", err);
            return `Erro ao salvar missão no banco de dados: ${err.message}`;
        }
    },
    {
        name: "start_mission",
        description: "Inicia uma nova missão para conversar com um número específico, salva o objetivo e manda a primeira mensagem para o alvo.",
        schema: z.object({
            targetNumber: z.string().describe("O número de telefone da pessoa (ex: 19999999999)."),
            objective: z.string().describe("O objetivo da missão (ex: 'Negociar a compra do carro XYZ por até 50 mil reais')."),
            firstMessage: z.string().describe("O texto exato da primeira mensagem que será enviada agora para o alvo (ex: 'Olá! Estou falando em nome do Luiz...')."),
            ttlHours: z.number().optional().describe("A validade da missão em horas. Para pedidos imediatos/rápidos (ex: 'comprar pão agora') use 4. Para coisas que podem durar dias (ex: 'negociar um carro') use 168 (7 dias). Padrão é 72h.")
        }),
    }
);

export const listMissionsTool = tool(
    async ({ targetNumber }, config) => {
        const threadId = config?.configurable?.thread_id;
        if (!threadId) return "Erro: não foi possível identificar o chat.";
        const masterJid = config?.configurable?.contextData?.chatJid;
        if (!masterJid) throw new Error("masterJid (chatJid) is required in contextData");

        try {
            let missions;
            if (targetNumber) {
                const { jid: targetJid } = await resolveAndFormatTargetJid(targetNumber);
                missions = await getRecentMissionsByTarget(masterJid, targetJid, 15);
                if (missions.length === 0) return `Nenhuma missão (ativa ou concluída) recentemente com o alvo ${targetJid}.`;
            } else {
                missions = await getRecentMissionsForMaster(masterJid, 15);
                if (missions.length === 0) return "Nenhuma missão (ativa ou concluída) recentemente.";
            }
            
            const list = missions.map(m => `- [ID: ${m.id}] ${m.status.toUpperCase()} | Alvo: ${m.targetJid}\n  Obj: ${m.objective}\n  Notas: ${m.notes || '-'}`).join("\n");
            return `<RAW_TOOL_OUTPUT source="sqlite:missions">\nMissões recentes:\n${list}\n</RAW_TOOL_OUTPUT>`;
        } catch (err: any) {
            logger.error("Erro ao listar missões:", err);
            return `Erro ao listar missões: ${err.message}`;
        }
    },
    {
        name: "list_missions",
        description: "Lista missões (ativas ou concluídas) recentes. Se você precisa saber o contexto de uma missão antiga com alguém específico, passe o targetNumber.",
        schema: z.object({
            targetNumber: z.string().optional().describe("Opcional: filtre pelo número de telefone do alvo (ex: 19999999999) para ver as missões antigas com ele antes de iniciar uma nova.")
        }),
    }
);

export const completeMissionTool = tool(
    async ({ id }, config) => {
        try {
            const success = await completeMission(id);
            if (success) {
                // Auto-resolve follow-ups vinculados a esta missão
                getFollowUps({ missionId: id, status: 'active' }).then(linked => {
                    for (const item of linked) {
                        resolveFollowUp(item.id, `Missão ID ${id} concluída.`);
                    }
                }).catch(e => logger.warn('[MISSION AGENT] Falha ao auto-resolver follow-up de missão:', e));

                return `✅ Missão ID ${id} foi marcada como concluída!`;
            } else {
                return `Missão ID ${id} não encontrada ou já concluída.`;
            }
        } catch (err: any) {
            logger.error("Erro ao concluir missão:", err);
            return `Erro ao atualizar missão: ${err.message}`;
        }
    },
    {
        name: "complete_mission",
        description: "Marca uma missão como concluída com sucesso.",
        schema: z.object({
            id: z.number().describe("O ID numérico da missão a ser concluída.")
        }),
    }
);

export const sendMessageToTargetTool = tool(
    async ({ targetNumber, message }, config) => {
        const accountName = config?.configurable?.contextData?.accountName || 'main';
        const { jid: targetJid } = await resolveAndFormatTargetJid(targetNumber);

        const sent = await sendDirectMessage(accountName, targetJid, message);
        if (sent) {
            // Registra no histórico do chat do alvo para manter contexto
            appendMessageToHistory(accountName, targetJid, {
                id: "mission-msg-" + Date.now(),
                timestamp: Date.now(),
                sender: accountName === 'personal' ? 'personal' : 'main',
                senderName: "Bia",
                content: message,
                isFromMe: true
            });
        }
        if (sent) {
            return `Mensagem agendada com sucesso para envio a ${targetJid}.`;
        } else {
            return `Falha ao agendar mensagem para ${targetJid}.`;
        }
    },
    {
        name: "send_message_to_target",
        description: "Envia uma mensagem direta para o alvo da missão. Use isso quando você for acionado pelo Master e precisar dar um feedback ao Target, ou quando precisar proativamente mandar algo.",
        schema: z.object({
            targetNumber: z.string().describe("O número de telefone do alvo (ou JID)."),
            message: z.string().describe("A mensagem exata a ser enviada.")
        }),
    }
);

export const notifyMasterTool = tool(
    async ({ message }, config) => {
        await notifyMaster(message);
        return "Notificação enviada ao Master com sucesso.";
    },
    {
        name: "notify_master",
        description: "Envia uma mensagem direta para o seu Mestre (Master). Use isso quando o Target responder algo e você precisar de instruções, aprovações, ou simplesmente avisar que a missão foi concluída.",
        schema: z.object({
            message: z.string().describe("A mensagem a ser enviada ao Mestre.")
        }),
    }
);

export const updateMissionNotesTool = tool(
    async ({ id, notes }, config) => {
        try {
            const success = await updateMissionNotes(id, notes);
            if (success) {
                return `✅ Anotações da missão ID ${id} atualizadas com sucesso!`;
            } else {
                return `Missão ID ${id} não encontrada.`;
            }
        } catch (err: any) {
            logger.error("Erro ao atualizar anotações da missão:", err);
            return `Erro ao atualizar anotações: ${err.message}`;
        }
    },
    {
        name: "update_mission_notes",
        description: "Salva ou atualiza as anotações (memória local) de uma missão. Use para guardar preços, endereços, horários e outros detalhes importantes negociados, para não esquecê-los nas próximas etapas.",
        schema: z.object({
            id: z.number().describe("O ID numérico da missão."),
            notes: z.string().describe("As anotações completas atualizadas da missão.")
        }),
    }
);

const MISSION_PROMPT = getSkill("missionAgent")?.detailedPrompt || "";

export const missionAgent = createReactAgent({
    llm: model,
    tools: [startMissionTool, listMissionsTool, completeMissionTool, updateMissionNotesTool, sendMessageToTargetTool, notifyMasterTool],
    messageModifier: MISSION_PROMPT,
});

export async function missionAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
    let systemContext: string | undefined = undefined;
    
    let details = state.contextData?.missionDetails;
    if (!details && state.contextData) {
        // Fallback robusto caso a Supervisora use outra chave
        details = state.contextData.missionInstructions || Object.values(state.contextData).find(v => v && typeof v === 'object' && (v.targetName || v.targetJids || v.messageToSend));
    }

    const threadId = config?.configurable?.thread_id || "";
    const chatKey = state.contextData?.chatJid || threadId;
    const targetMissions = state.contextData?.activeMissions?.filter((m: any) => jidsMatch(m.targetJid, chatKey)) || [];
    const masterMissions = state.contextData?.activeMissions?.filter((m: any) => jidsMatch(m.masterJid, chatKey)) || [];
    
    const recentTargetMissions = state.contextData?.recentMissions?.filter((m: any) => jidsMatch(m.targetJid, chatKey) && m.status !== 'active') || [];
    const recentMasterMissions = state.contextData?.recentMissions?.filter((m: any) => jidsMatch(m.masterJid, chatKey) && m.status !== 'active') || [];

    const todayStr = new Date().toISOString();
    const systemPrefix = `[CONTEXTO DE TEMPO] Data e hora atual: ${todayStr}\nSe uma missão for muito antiga, considere o contexto temporal.\n\n`;

    if (targetMissions.length > 0) {
        systemContext = systemPrefix + `[MISSÕES ATIVAS - RESPOSTA DO ALVO]
Você está conversando com o alvo de uma ou mais missões ativas.
Detalhes das missões: ${JSON.stringify(targetMissions, null, 2)}
Analise a mensagem do alvo e decida o que fazer.
- Se puder continuar a negociação sozinho, use 'send_message_to_target'.
- Se precisar da aprovação ou instrução do Master, use 'notify_master'.
- Se o alvo estiver apenas encerrando a conversa cordialmente (ex: "de nada", "ok", "tchau") de uma missão que já havia sido notificada ou resolvida com o Master, NÃO use 'notify_master' reenviando resumos antigos. Apenas use 'complete_mission'.
- Se a missão foi concluída com sucesso, use 'complete_mission'.
NÃO inicie uma nova missão (não use start_mission).`;
    } else if (masterMissions.length > 0) {
        systemContext = systemPrefix + `[MISSÕES ATIVAS - INSTRUÇÃO DO MASTER]
Você está gerenciando missões ativas para o Master. O Master está te dando uma instrução, aprovação ou respondendo a uma notificação.
Detalhes das missões: ${JSON.stringify(masterMissions, null, 2)}
Aja como o agente encarregado. 
- Use 'send_message_to_target' para repassar a decisão/mensagem ao alvo da missão.
- Se o Master der a última instrução de encerramento (ex: "agradece e diz que vou pensar"), use 'complete_mission' OBRIGATORIAMENTE junto no mesmo turno para não deixar a missão aberta.
NÃO inicie nova missão.`;
    } else if (recentTargetMissions.length > 0 && !details && !state.contextData?.specialistTask) {
        systemContext = systemPrefix + `[RETOMADA DE MISSÃO - RESPOSTA DO ALVO]
O alvo enviou uma mensagem, mas a missão recente dele já estava marcada como concluída/inativa.
Detalhes da missão concluída: ${JSON.stringify(recentTargetMissions.slice(0, 1), null, 2)}
Ação esperada: Avalie a nova mensagem do alvo. Se for apenas um "tchau" ou irrelevante, ignore. Se for uma nova informação importante para a missão, use 'notify_master' para avisar o Master. Se precisar, use 'start_mission' para reabrir o contexto e responder.`;
    } else if (details || state.contextData?.specialistTask) {
        systemContext = systemPrefix + `[INFORMAÇÕES DA MISSÃO PREPARADAS PELA SUPERVISORA]
O alvo da missão é: ${details?.targetName || 'Não especificado'}
Números/JIDs encontrados na memória: ${Array.isArray(details?.targetJids) ? details?.targetJids.join(", ") : details?.targetJids || 'Nenhum'}

Contexto do que o Master deseja: ${details?.context || details?.missionInstructions || state.contextData?.specialistTask || JSON.stringify(details)}
Objetivo da missão: ${details?.goal || 'Completar a solicitação do Master'}

SUGESTÃO DE AÇÃO:
Você já tem as informações do alvo. Use a ferramenta 'start_mission' IMEDIATAMENTE usando o JID/telefone mais adequado.
Mensagem inicial sugerida: "${details?.messageToSend || 'Olá! Estou falando em nome do Luiz...'}"
Informações adicionais para você saber: ${details?.additionalInfo || 'Nenhuma'}`;
    } else if (state.contextData) {
        // Fallback final
        systemContext = `[INSTRUÇÕES GERAIS DA SUPERVISORA]\n${JSON.stringify(state.contextData, null, 2)}\nCumpra a instrução do Master.`;
    }

    const result = await safeAgentNode("missionAgent", () => missionAgent, state, undefined, config, systemContext);
    
    const contextData = result.contextData as any;
    const executedTools = contextData?.newExecutedTools || [];

    // Flag universal: qualquer tool de comunicação do missionAgent deve silenciar a resposta
    // da Supervisora, evitando que resumos internos vazem para o chat do Target ou do Master.
    const missionToolsUsed = executedTools.some((t: string) => 
        ['send_message_to_target', 'notify_master', 'start_mission'].includes(t)
    );
    if (missionToolsUsed) {
        result.contextData = contextData || {};
        (result.contextData as any).master_notified = true;
        (result.contextData as any).mission_handled = true;
    }
    
    return result;
}
