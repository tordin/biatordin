import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { agent } from '../graph/workflow.js';
import { logger, generateTriggerId, setActiveTrigger, clearActiveTrigger, getActiveTrigger, runWithTriggerContext, loggerCallbackHandler, triggerStorage } from '../utils/logger.js';
import { resolveTopicForMessage } from '../utils/topicBroker.js';
import { getTopic, updateTopicActivity } from '../memory/topics.js';
import { isTrustedChat, MASTER_NUMBER, MASTER_JIDS } from '../memory/security.js';
import { isGroupIgnored, addIgnoredGroup, removeIgnoredGroup, isGroupManagementCommand } from '../config/ignoredGroups.js';
import { appendMessageToHistory } from '../memory/chatHistory.js';
import { isCommand, handleCommand, getChatModelOverride } from '../commands/commandRouter.js';
import { savePendingMessage, getAllPendingMessages, clearPendingMessagesForQueue, clearStalePendingMessages } from '../memory/pendingQueue.js';
import { hasActiveMissionForTarget, getActiveMissionsForTarget, getActiveMissionsForChat, getRecentMissionsForChat } from '../memory/missions.js';
import { autoResolveFollowUpsForChat } from '../memory/followUps.js';
import { loadLidMappings, registerLidMapping, jidsMatch, canonicalJid } from '../utils/jidResolver.js';
import OpenAI, { toFile } from 'openai';
import { triggerSimulator } from '../utils/simulator.js';
import { updateContactPushName } from '../memory/contacts.js';

const groqClient = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let globalSock: any = null; // Default main sock for legacy global functions
const sockets = new Map<string, any>();
const botJids = new Map<string, string | null>();
const botLids = new Map<string, string | null>();
const reconnectAttempts = new Map<string, number>();
const consecutiveConflicts = new Map<string, number>();

// Conjunto para rastrear mensagens enviadas pelo bot e evitar loops infinitos
const botSentMessageIds = new Set<string>();

interface SentMessageRecord {
    normalizedText: string;
    timestamp: number;
}
const recentOutboundMessages = new Map<string, SentMessageRecord[]>(); // Key is chatJid
const OUTBOUND_DEDUP_TTL_MS = 60000;

function normalizeText(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, "") // remove accents
        .replace(/[^\w\s]|_/g, "") // remove punctuation and emojis
        .replace(/\s+/g, " ")
        .trim();
}

export function shouldBlockMessage(chatJid: string, text: string): boolean {
    const normalized = normalizeText(text);
    if (!normalized) return false; // Don't block empty/media-only

    const now = Date.now();
    const records = recentOutboundMessages.get(chatJid) || [];
    
    // Clean up old records
    const validRecords = records.filter(r => now - r.timestamp < OUTBOUND_DEDUP_TTL_MS);
    recentOutboundMessages.set(chatJid, validRecords);

    // Check for duplicates
    for (const record of validRecords) {
        if (record.normalizedText === normalized) {
            return true; // Duplicate found!
        }
    }

    // Not a duplicate, add to history
    validRecords.push({ normalizedText: normalized, timestamp: now });
    return false;
}

export interface MessageMetadata {
    isGroup: boolean;
    mentionsBia: boolean;
    isReplyToBot: boolean;
    wasReceivedWhileProcessing: boolean;
}

interface BufferedMessage {
    text: string;
    displayName: string;
    messageId: string;
    userJid: string;
    timestamp: number;
    metadata: MessageMetadata;
}

interface ChatState {
    accountName: string;
    messages: BufferedMessage[];
    timeoutId: NodeJS.Timeout | null;
    isProcessing: boolean;
    firstMessageTime: number;
    lastSilenceDelay?: number;
}

const chatQueues = new Map<string, ChatState>();

// Rate limiting: max 5 calls from same chat in 30 seconds
const rateLimitTimestamps = new Map<string, number[]>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 30_000;
const groupNameCache = new Map<string, string>();
const subscribedPresenceJids = new Set<string>();

async function recoverPendingMessagesOnStartup(accountName: string, sock: any) {
    try {
        // 1. Purga mensagens pendentes antigas (> 24h) de execuções ou simulações mortas
        await clearStalePendingMessages(24).catch(err =>
            logger.warn(`[RECOVERY] Erro ao purgar mensagens pendentes antigas:`, err)
        );

        const pending = await getAllPendingMessages();
        const accountPending = pending.filter(p => p.accountName === accountName);
        if (accountPending.length > 0) {
            logger.info(`[RECOVERY] Encontradas ${accountPending.length} mensagens pendentes para a conta ${accountName}. Reagendando processamento...`);
            const recoveredQueueKeys = new Set<string>();

            for (const item of accountPending) {
                const queueKey = item.queueKey;
                recoveredQueueKeys.add(queueKey);
                let queue = chatQueues.get(queueKey);
                if (!queue) {
                    queue = {
                        accountName: item.accountName,
                        messages: [],
                        timeoutId: null,
                        isProcessing: false,
                        firstMessageTime: item.timestamp || Date.now()
                    };
                    chatQueues.set(queueKey, queue);
                } else if (item.timestamp && item.timestamp < queue.firstMessageTime) {
                    queue.firstMessageTime = item.timestamp;
                }
                const meta = item.metadata ? (typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata) : {};
                queue.messages.push({
                    text: item.text,
                    displayName: item.displayName,
                    messageId: item.id || `rec-${Date.now()}`,
                    userJid: item.userJid,
                    timestamp: item.timestamp,
                    metadata: meta
                });
            }

            // 2. Agenda o processamento para todas as filas que tiveram mensagens recuperadas
            for (const queueKey of recoveredQueueKeys) {
                const queue = chatQueues.get(queueKey);
                if (queue && queue.messages.length > 0 && !queue.isProcessing && !queue.timeoutId) {
                    const delayTime = accountName === 'personal' ? 5000 : 3000;
                    logger.info(`[RECOVERY] Agendando fila recuperada ${queueKey} (${queue.messages.length} msgs) para processamento em ${delayTime}ms.`);
                    queue.timeoutId = setTimeout(() => {
                        processChatQueue(queueKey, sock);
                    }, delayTime);
                }
            }
        }
    } catch (e) {
        logger.error(`[RECOVERY] Erro na recuperação de mensagens pendentes (${accountName}):`, e);
    }
}

async function getChatName(sock: any, chatJid: string, accountName: string): Promise<string> {
    if (!chatJid.endsWith('@g.us')) return "";
    const key = `${accountName}:${chatJid}`;
    if (groupNameCache.has(key)) return groupNameCache.get(key)!;
    try {
        const meta = await sock.groupMetadata(chatJid);
        const name = meta?.subject || "";
        groupNameCache.set(key, name);
        return name;
    } catch {
        groupNameCache.set(key, "");
        return "";
    }
}

export const BASE_SILENCE_THRESHOLD_MS = 2500; // 2.5s para resposta rápida se a ideia parece concluída
export const INCOMPLETE_SILENCE_THRESHOLD_MS = 15000; // 15s se a ideia parecer incompleta (reticências, conectivos, etc.)
export const MAX_WAIT_MS = 60000; // Máximo de 1 minuto de espera no total (se continuar digitando/mandando mensagens)

export function getSilenceDelayForMessage(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return BASE_SILENCE_THRESHOLD_MS;

    // 1. Termina com reticências, dois pontos, vírgula, ponto e vírgula ou traço/hífen
    if (trimmed.endsWith('...') || trimmed.endsWith('..') || trimmed.endsWith(',') || trimmed.endsWith(':') || trimmed.endsWith(';') || trimmed.endsWith('-')) {
        return INCOMPLETE_SILENCE_THRESHOLD_MS;
    }

    const words = trimmed.toLowerCase().split(/\s+/);
    const lastWord = words[words.length - 1];
    
    // Remove caracteres não-alfabéticos do final da última palavra (ex: pontuações, aspas, emojis comuns)
    const cleanLastWord = lastWord.replace(/[^a-zA-Záéíóúâêîôûãõç]/g, '');

    // Conectivos, preposições e verbos auxiliares/de ligação no final sugerem continuação da ideia
    const continuationWords = new Set([
        'e', 'mas', 'ou', 'pq', 'porque', 'tipo', 'como', 'se', 'que', 'pois', 
        'então', 'entao', 'daí', 'dai', 'aí', 'ai', 'de', 'para', 'com', 'em', 
        'a', 'por', 'sob', 'sobre', 'vou', 'quero', 'preciso', 'tenho', 'fazer', 
        'ir', 'ia', 'tá', 'ta', 'pra', 'pro'
    ]);

    if (continuationWords.has(cleanLastWord)) {
        return INCOMPLETE_SILENCE_THRESHOLD_MS;
    }

    // 2. Pontuação forte indica conclusão de ideia
    const strongPunctuation = /[.?!]$/;
    if (strongPunctuation.test(trimmed)) {
        return BASE_SILENCE_THRESHOLD_MS;
    }

    // 3. Saudações e respostas rápidas curtas comuns (mesmo sem pontuação final) devem responder rápido
    const commonGreetings = new Set([
        'oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite', 
        'bia', 'ei', 'tudo bem', 'blz', 'beleza', 'obrigado', 
        'obrigada', 'valeu', 'tchau', 'flw'
    ]);
    const cleanMessage = trimmed.toLowerCase().replace(/[^a-z0-9áéíóúâêîôûãõç\s]/g, '').trim();
    if (commonGreetings.has(cleanMessage)) {
        return BASE_SILENCE_THRESHOLD_MS;
    }

    // 4. Sem pontuação forte e sem conectivo explícito: consideramos ambíguo.
    // Usamos um meio-termo de 5 segundos para ser responsivo, mas dar uma janela caso a pessoa queira mandar outra mensagem.
    return 5000;
}

// Função utilitária para normalizar JIDs e remover o sufixo de dispositivo (:xx)
export function normalizeJid(jid: string | null | undefined): string {
    if (!jid) return "";
    const [userWithDev, serverWithDev] = jid.split('@');
    if (!serverWithDev) return userWithDev.split(':')[0];
    const cleanUser = userWithDev.split(':')[0];
    const cleanServer = serverWithDev.split(':')[0];
    return `${cleanUser}@${cleanServer}`;
}

// Conjunto em memória para rastrear os JIDs dos grupos dos quais a conta main (Bia) faz parte
const mainGroupJids = new Set<string>();

/**
 * Verifica se um JID é de transmissão ou Status/Stories do WhatsApp (ex: status@broadcast)
 */
export function isBroadcastJid(jid: string | null | undefined): boolean {
    const norm = normalizeJid(jid);
    if (!norm) return false;
    return norm === 'status@broadcast' || norm.endsWith('@broadcast');
}

/**
 * Verifica se um determinado JID pertence à própria Bia (conta main)
 */
export function isMessageFromBia(userJid: string): boolean {
    const normUser = normalizeJid(userJid);
    if (!normUser) return false;

    const mainSock = sockets.get('main') || globalSock;
    const mainJid = botJids.get('main') || (mainSock?.user?.id ? normalizeJid(mainSock.user.id) : null);
    const mainLid = botLids.get('main') || (mainSock?.user?.lid ? normalizeJid(mainSock.user.lid) : null);

    if (mainJid && normUser === mainJid) return true;
    if (mainLid && normUser === mainLid) return true;

    return false;
}

let lastMainGroupRefresh = 0;

/**
 * Atualiza a lista de grupos em que a conta main da Bia participa.
 * Utiliza um throttle de 5 minutos para evitar rate limit do WhatsApp.
 */
export async function refreshMainGroupJids(force = false): Promise<Set<string>> {
    const now = Date.now();
    if (!force && now - lastMainGroupRefresh < 5 * 60 * 1000) {
        return mainGroupJids;
    }

    const mainSock = sockets.get('main') || globalSock;
    if (mainSock) {
        try {
            const groups = await mainSock.groupFetchAllParticipating();
            for (const gId of Object.keys(groups)) {
                mainGroupJids.add(gId);
            }
            lastMainGroupRefresh = now;
        } catch (e) {
            logger.error('[WHATSAPP] Erro ao atualizar grupos da conta main:', e);
        }
    }
    return mainGroupJids;
}


async function processChatQueue(queueKey: string, sock: any) {
    const queue = chatQueues.get(queueKey);
    if (!queue) return;

    const [accountName, rawChatJid] = queueKey.split(':');
    const chatJid = canonicalJid(rawChatJid);

    if (queue.isProcessing) {
        logger.info(`[DEBOUNCE] Fila de ${queueKey} já está sendo processada.`);
        return;
    }

    if (queue.messages.length === 0) {
        return;
    }

    queue.isProcessing = true;
    if (queue.timeoutId) {
        clearTimeout(queue.timeoutId);
        queue.timeoutId = null;
    }

    // Copia e esvazia a fila de mensagens
    const messagesToProcess = [...queue.messages];
    queue.messages = [];

    // Limpa da fila SQLite permanente uma vez que as mensagens passaram para execução
    clearPendingMessagesForQueue(queueKey).catch(err =>
        logger.error(`[PENDING_QUEUE DB] Erro ao limpar mensagens do SQLite para ${queueKey}:`, err)
    );

    // Declared outside try so the catch block can reference them for error logging
    let activeTriggerCtx: ReturnType<typeof setActiveTrigger> | null = null;
    let triggerStartMs = 0;
    let resolvedThreadId = '';

    try {
        const isGroup = chatJid.endsWith('@g.us');
        const isPersonalGroup = isGroup && accountName === 'personal';

        // Guardrail: Truncate combined text to 2000 characters
        let groupedMessages: { displayName: string, text: string, timestamp: number, metadata?: any }[] = [];
        for (const m of messagesToProcess) {
            if (groupedMessages.length > 0 && groupedMessages[groupedMessages.length - 1].displayName === m.displayName && !m.metadata?.wasReceivedWhileProcessing) {
                groupedMessages[groupedMessages.length - 1].text += `\n${m.text}`;
            } else {
                groupedMessages.push({ ...m });
            }
        }

        let combinedText = groupedMessages.map(m => {
            const requiresSenderPrefix = isGroup || accountName === 'personal';
            return requiresSenderPrefix ? `${m.displayName}:\n${m.text}` : m.text;
        }).join("\n---\n");

        const maxChars = 30000;
        if (combinedText.length > maxChars) {
            logger.warn(`[GUARDRAIL] Mensagem truncada de ${combinedText.length} para ${maxChars} caracteres no chat ${chatJid}`);
            combinedText = combinedText.substring(0, maxChars);
        }

        // Guardrail: Rate limiting — max 5 calls from same chat in 30s
        const now = Date.now();
        let timestamps = rateLimitTimestamps.get(queueKey) || [];
        timestamps = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (timestamps.length >= RATE_LIMIT_MAX) {
            logger.warn(`[GUARDRAIL] Rate limit atingido para ${queueKey}: ${timestamps.length} chamadas em ${RATE_LIMIT_WINDOW_MS}ms. Mensagens serão recolocadas na fila para retry.`);
            // Re-queue messages so they are not permanently lost
            queue.messages = [...messagesToProcess, ...queue.messages];
            queue.isProcessing = false;
            return;
        }
        timestamps.push(now);
        rateLimitTimestamps.set(queueKey, timestamps);

        // Verifica se há missão ativa para este chat ANTES de classificar o tópico.
        // Se houver, fixa o tópico para evitar fragmentação de threads no LangGraph.
        const earlyMissions = await getActiveMissionsForChat(chatJid);
        
        let hasMissionActive = false;
        if (accountName === 'main') {
            hasMissionActive = earlyMissions.length > 0;
        } else if (accountName === 'personal') {
            hasMissionActive = earlyMissions.some((m: any) => jidsMatch(m.masterJid, chatJid));
        }

        let topicId: string;
        let title: string;
        if (hasMissionActive) {
            // Missão ativa: usar tópico fixo para manter continuidade do state no LangGraph
            topicId = 'mission';
            title = 'Missão Ativa';
            logger.info(`[DEBOUNCE] Chat ${chatJid} tem missão ativa. Fixando tópico como 'Missão Ativa' para evitar fragmentação de thread.`);
        } else {
            const resolved = await resolveTopicForMessage(chatJid, combinedText, accountName);
            topicId = resolved.topicId;
            title = resolved.title;
        }
        const threadId = `${accountName}_${chatJid}_${topicId}`;

        logger.info(`[DEBOUNCE] Direcionando mensagens para o assunto: "${title}" (Thread: ${threadId})`);

        let addedWarning = false;
        const humanMessages = groupedMessages.map(
            m => {
                const dateStr = new Date(m.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                const requiresSenderPrefix = isGroup || accountName === 'personal';
                let msgContent = requiresSenderPrefix ? `${m.displayName}:\n${m.text}` : m.text;
                if (m.metadata?.wasReceivedWhileProcessing) {
                    if (!addedWarning) {
                        msgContent = `[⚠️ As mensagens a seguir foram enviadas enquanto você formulava a resposta anterior]\n${msgContent}`;
                        addedWarning = true;
                    }
                }
                return new HumanMessage({ content: `[${dateStr}]\n${msgContent}`, name: m.displayName });
            }
        );

        const isTrusted = await isTrustedChat(chatJid);
        const lastMsg = messagesToProcess[messagesToProcess.length - 1];
        const lastMsgUserJid = canonicalJid(lastMsg?.userJid || chatJid);
        const senderName = lastMsg?.displayName || "Desconhecido";
        
        let chatName = chatJid;
        if (isGroup) {
            chatName = await getChatName(sock, chatJid, accountName) || "Grupo Desconhecido";
        }

        // ── TRIGGER: register the generating event before invoking the agent ──
        const triggerId = generateTriggerId();
        const resolvedTriggerType = 'whatsapp_message';
        resolvedThreadId = threadId;
        const triggerCtx = setActiveTrigger(threadId, {
            triggerId,
            triggerType: resolvedTriggerType,
            threadId,
            chatJid,
            chatName,
            senderJid: lastMsgUserJid,
            senderName: senderName,
            accountName,
            messageContent: combinedText,
            metadata: {
                isGroup,
                mentionsBia: messagesToProcess.some(m => m.metadata?.mentionsBia),
                isReplyToBot: messagesToProcess.some(m => m.metadata?.isReplyToBot),
                wasReceivedWhileProcessing: messagesToProcess.some(m => m.metadata?.wasReceivedWhileProcessing),
            },
        });
        activeTriggerCtx = triggerCtx;
        logger.logTriggerEvent(triggerCtx);
        triggerStartMs = Date.now();

        await runWithTriggerContext(triggerCtx, async () => {
            const config = { 
                configurable: { thread_id: threadId },
                metadata: { 
                    threadId: threadId, 
                    agentName: "graph",
                    chatJid: chatJid,
                    chatName: chatName,
                    accountName: accountName,
                    isGroup: isGroup,
                    isTrusted: isTrusted,
                    topicTitle: title,
                },
                tags: [
                    accountName,
                    isGroup ? 'group' : 'private',
                    isTrusted ? 'trusted' : 'untrusted'
                ],
                callbacks: [loggerCallbackHandler],
                recursionLimit: 25,
                runName: `Bia (${isGroup ? (chatName || chatJid) : (senderName || chatJid)})`
            };
            const activeMissions = await getActiveMissionsForChat(chatJid);
            const recentMissions = await getRecentMissionsForChat(chatJid, 10);

            // V7: Se este chat é alvo de uma missão ativa, injetar histórico recente
            // para que o missionAgent saiba o que a Bia já disse
            let missionChatHistory = '';
            const isTargetOfMission = activeMissions.some((m: any) => jidsMatch(m.targetJid, chatJid));
            if (isTargetOfMission) {
                const { getChatHistory } = await import('../memory/chatHistory.js');
                const recentHistory = getChatHistory(accountName, chatJid, 20);
                if (recentHistory.length > 0) {
                    missionChatHistory = recentHistory.map(h => 
                        `[${h.date || new Date(h.timestamp).toLocaleString('pt-BR')}] ${h.isFromMe ? 'Bia' : h.senderName}: ${h.content}`
                    ).join('\n');
                }
            }

            const result = await agent.invoke({
                messages: humanMessages,
                contextData: { 
                    active_topic_title: title,
                    topicId: topicId,
                    isMaster: MASTER_JIDS.includes(canonicalJid(chatJid)) || MASTER_JIDS.includes(canonicalJid(lastMsgUserJid)),
                    isTrustedChat: isTrusted,
                    isGroup: isGroup,
                    chatJid: chatJid,
                    chatName: chatName,
                    senderJid: lastMsgUserJid,
                    senderName: senderName,
                    masterNumber: MASTER_NUMBER,
                    accountName: accountName,
                    activeMissions: activeMissions,
                    recentMissions: recentMissions,
                    missionChatHistory: missionChatHistory || undefined,
                    executionLog: [],
                    executedTools: [],
                    activePlan: [],
                    outputMessages: []
                }
            }, config);

            const responseMessage = result.messages[result.messages.length - 1];
            let responseText = (responseMessage instanceof AIMessage)
                ? (typeof responseMessage.content === 'string' ? responseMessage.content : JSON.stringify(responseMessage.content))
                : '';

            // Collect agents used from contextData executionLog
            const agentsUsed: string[] = result.contextData?.executionLog || [];

            // Correção de missões: evitar vazamentos para o chat do Target.
            // Se o missionAgent atuou, verificamos se este é um chat de um alvo ativo.
            // Comparação LID↔número: alvo responde via @lid, missões salvas com número.
            const isTargetChat = (result.contextData?.activeMissions || []).some((m: any) => jidsMatch(m.targetJid, chatJid)) || 
                                 (result.contextData?.recentMissions || []).some((m: any) => jidsMatch(m.targetJid, chatJid));
            const missionToolsUsed = (result.contextData?.executedTools || []).some((t: string) =>
                ['send_message_to_target', 'notify_master', 'start_mission'].includes(t)
            );
            
            let silenceReason = result.contextData?.silenceReason;

            if (agentsUsed.includes("missionAgent") && isTargetChat) {
                if (responseText && responseText.trim().toUpperCase() !== '[SILENT]') {
                    logger.info(`[WHATSAPP] missionAgent atuou em chat de alvo. Suprimindo resposta textual bruta para evitar vazamentos (use send_message_to_target).`);
                    responseText = '';
                    silenceReason = 'Ação tratada pelo especialista de missão (resposta textual suprimida no chat do alvo).';
                }
            } else if (missionToolsUsed && responseText && responseText.trim().toUpperCase() !== '[SILENT]') {
                logger.info(`[WHATSAPP] missionAgent já tratou a comunicação via tools. Suprimindo resposta do pipeline para ${chatJid}.`);
                responseText = '';
                silenceReason = 'Comunicação já realizada via ferramentas da missão.';
            }

            // Bloqueio de segurança para a conta pessoal (READ-ONLY)
            if (accountName === 'personal') {
                if (responseText && responseText.trim().toUpperCase() !== '[SILENT]') {
                    const isTechnicalErrorMsg = responseText.toLowerCase().includes('instabilidade') || 
                                                responseText.toLowerCase().includes('não consegui processar') ||
                                                responseText.toLowerCase().includes('tente novamente') ||
                                                responseText.toLowerCase().includes('falha técnica');
                    if (isTechnicalErrorMsg) {
                        logger.warn(`[SECURITY] Erro técnico suprimido na conta pessoal (sem envio de alerta espúrio ao Master): "${responseText}"`);
                        silenceReason = 'Conta pessoal: Erro técnico interno suprimido (silêncio mantido).';
                    } else {
                        logger.warn(`[SECURITY] IA gerou resposta na conta pessoal. Encaminhando mensagem gerada como alerta natural para o Master. Chat de origem: ${chatJid}`);
                        await notifyMaster(responseText);
                        silenceReason = 'Conta pessoal: Alerta enviado em privado para o Master (silêncio mantido com terceiro).';
                    }
                } else {
                    // Usa o silenceReason descritivo gerado pelo supervisor (via contextDataUpdate)
                    // Fallback: constrói a razão a partir das memórias episódicas salvas
                    if (!silenceReason) {
                        const episodicMemories: any[] = result.contextData?.newEpisodicMemories || [];
                        if (episodicMemories.length > 0) {
                            const memorySummary = episodicMemories
                                .map((m: any) => typeof m === 'string' ? m : (m?.content || JSON.stringify(m)))
                                .join('; ');
                            silenceReason = `Conta pessoal: Guardei na memória — ${memorySummary}`;
                        } else {
                            silenceReason = 'Conta pessoal: Ignorei — sem fatos relevantes para registrar.';
                        }
                    }
                }
                responseText = ''; // Força silêncio absoluto no socket da conta pessoal
            }


            // Se a resposta for '[SILENT]' ou vazia/não-AIMessage, não enviamos nenhuma mensagem de volta
            if (!responseText || responseText.trim().toUpperCase() === '[SILENT]') {
                silenceReason = silenceReason || result.contextData?.silenceReason || 'Silêncio intencional mantido pela Bia.';
                logger.info(`[DEBUG] Bia decidiu ficar em silêncio (${silenceReason}) no chat ${chatJid} (Conta: ${accountName}).`);
                // Log trigger outcome: silent
                logger.logTriggerOutcome(triggerCtx, {
                    action: 'silent',
                    reason: silenceReason,
                    agentsUsed,
                    durationMs: Date.now() - triggerStartMs,
                });
                clearActiveTrigger(threadId);
            } else {
                // Log trigger outcome: responded
                logger.logTriggerOutcome(triggerCtx, {
                    action: 'responded',
                    responseText,
                    agentsUsed,
                    durationMs: Date.now() - triggerStartMs,
                });
                clearActiveTrigger(threadId);

                await queueMessageSend(queueKey, async () => {
                    // Ativa indicador de digitando apenas se de fato vamos responder
                    await sock.sendPresenceUpdate('composing', chatJid);

                    // Simula tempo de digitação natural baseado no tamanho do texto
                    const typingTime = Math.min(Math.max(responseText.length * 30, 1000), 4000);
                    await delay(typingTime);

                    await sock.sendPresenceUpdate('paused', chatJid);

                    if (shouldBlockMessage(chatJid, responseText)) {
                        logger.warn(`[WHATSAPP] Resposta final barrada por deduplicação: "${responseText}"`);
                        return;
                    }
                    await sock.sendMessage(chatJid, { text: responseText });
                });
            }
        });
    } catch (error) {
        logger.error(`Erro ao processar fila do chat ${chatJid}:`, error);
        // Log trigger outcome: error — use the outer-scoped triggerCtx if available
        if (activeTriggerCtx) {
            logger.logTriggerOutcome(activeTriggerCtx, {
                action: 'error',
                error: error instanceof Error ? error.message : String(error),
                durationMs: triggerStartMs ? Date.now() - triggerStartMs : undefined,
            });
            clearActiveTrigger(resolvedThreadId);
        }
        try {
            await sock.sendPresenceUpdate('paused', chatJid);
        } catch (_) {}
    } finally {
        queue.isProcessing = false;

        // Se novas mensagens chegaram enquanto estávamos processando, agenda nova execução
        if (queue.messages.length > 0) {
            logger.info(`[DEBOUNCE] Novas mensagens chegaram durante o processamento para ${queueKey}. Agendando novo timer.`);
            queue.firstMessageTime = Date.now();
            
            const lastMsg = queue.messages[queue.messages.length - 1];
            const silenceDelay = getSilenceDelayForMessage(lastMsg.text);
            queue.lastSilenceDelay = silenceDelay;

            queue.timeoutId = setTimeout(() => {
                processChatQueue(queueKey, sock);
            }, silenceDelay);
        } else {
            chatQueues.delete(queueKey);
        }
    }
}

export interface SystemInjectOptions {
    triggerType?: 'cron_routine' | 'system_inject';
    routineId?: number;
    routinePrompt?: string;
    topicId?: string;
}

const systemExecutionQueues = new Map<string, Promise<void>>();

async function executeIsolatedSystemMessage(
    chatJid: string,
    text: string,
    accountName: string,
    options: SystemInjectOptions
) {
    const sock = sockets.get(accountName) || globalSock;
    if (!sock) {
        logger.error(`[ISOLATED SYSTEM EXECUTION] Socket para ${accountName} não está inicializado.`);
        return;
    }

    const resolvedChatJid = canonicalJid(chatJid);
    const isGroup = resolvedChatJid.endsWith('@g.us');
    let chatName = resolvedChatJid;
    if (isGroup) {
        chatName = (await getChatName(sock, resolvedChatJid, accountName)) || "Grupo Desconhecido";
    }
    const isTrusted = await isTrustedChat(resolvedChatJid);

    // Resolve Topic
    let topicId = options.topicId;
    let title = '';
    if (topicId) {
        try {
            const existingTopic = await getTopic(topicId);
            if (existingTopic && existingTopic.status === 'active') {
                title = existingTopic.title;
                await updateTopicActivity(topicId);
            } else {
                topicId = undefined;
            }
        } catch (e) {
            logger.warn(`[ISOLATED SYSTEM EXECUTION] Erro ao buscar topicId ${topicId}:`, e);
            topicId = undefined;
        }
    }

    if (!topicId || !title) {
        const resolved = await resolveTopicForMessage(resolvedChatJid, text, accountName);
        topicId = resolved.topicId;
        title = resolved.title;
    }

    const threadId = `${accountName}_${resolvedChatJid}_${topicId}`;
    logger.info(`[ISOLATED SYSTEM EXECUTION] Executando mensagem de sistema no assunto: "${title}" (Thread: ${threadId}, Routine ID: ${options.routineId || 'N/A'})`);

    const dateStr = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const humanMessages = [
        new HumanMessage({
            content: `[${dateStr}]\n${text}`,
            name: "SISTEMA",
        })
    ];

    const triggerId = generateTriggerId();
    const resolvedTriggerType = options.triggerType || 'cron_routine';
    const triggerCtx = setActiveTrigger(threadId, {
        triggerId,
        triggerType: resolvedTriggerType,
        threadId,
        chatJid: resolvedChatJid,
        chatName,
        senderJid: undefined,
        senderName: 'SISTEMA',
        accountName,
        messageContent: text,
        metadata: {
            isGroup,
            mentionsBia: false,
            isReplyToBot: false,
            wasReceivedWhileProcessing: false,
        },
        routineId: options.routineId,
        routinePrompt: options.routinePrompt,
    });

    logger.logTriggerEvent(triggerCtx);
    const triggerStartMs = Date.now();

    try {
        await runWithTriggerContext(triggerCtx, async () => {
            const config = {
                configurable: { thread_id: threadId },
                metadata: { 
                    threadId: threadId, 
                    agentName: "graph",
                    chatJid: resolvedChatJid,
                    chatName: chatName,
                    accountName: accountName,
                    isGroup: isGroup,
                    isTrusted: isTrusted,
                    topicTitle: title,
                    source: "system-trigger"
                },
                tags: [
                    accountName,
                    isGroup ? 'group' : 'private',
                    isTrusted ? 'trusted' : 'untrusted',
                    'system-trigger'
                ],
                callbacks: [loggerCallbackHandler],
                recursionLimit: 25,
                runName: `Bia System (${chatName || resolvedChatJid})`
            };
            const activeMissions = await getActiveMissionsForChat(resolvedChatJid);
            const recentMissions = await getRecentMissionsForChat(resolvedChatJid, 10);

            const result = await agent.invoke({
                messages: humanMessages,
                contextData: {
                    active_topic_title: title,
                    topicId: topicId,
                    isMaster: MASTER_JIDS.includes(canonicalJid(resolvedChatJid)),
                    isTrustedChat: isTrusted,
                    isGroup: isGroup,
                    chatJid: resolvedChatJid,
                    chatName: chatName,
                    senderJid: resolvedChatJid,
                    senderName: "SISTEMA",
                    masterNumber: MASTER_NUMBER,
                    accountName: accountName,
                    activeMissions: activeMissions,
                    recentMissions: recentMissions,
                    executionLog: [],
                    executedTools: [],
                    activePlan: [],
                    outputMessages: []
                }
            }, config);

            const responseMessage = result.messages[result.messages.length - 1];
            let responseText = (responseMessage instanceof AIMessage)
                ? (typeof responseMessage.content === 'string' ? responseMessage.content : JSON.stringify(responseMessage.content))
                : '';

            const agentsUsed: string[] = (result.contextData?.executionLog as string[]) || [];

            const executedTools: string[] = (result.contextData?.executedTools as string[]) || [];
            const missionTools = ['create_mission', 'update_mission', 'cancel_mission', 'list_missions', 'send_mission_message'];
            const missionToolsUsed = executedTools.some(t => missionTools.includes(t));

            let silenceReason = result.contextData?.silenceReason;

            if (missionToolsUsed && responseText && responseText.trim().toUpperCase() !== '[SILENT]') {
                logger.info(`[WHATSAPP] missionAgent já tratou a comunicação via tools. Suprimindo resposta do pipeline para ${resolvedChatJid}.`);
                responseText = '';
                silenceReason = 'Comunicação já realizada via ferramentas da missão.';
            }

            if (accountName === 'personal') {
                if (responseText && responseText.trim().toUpperCase() !== '[SILENT]') {
                    logger.warn(`[SECURITY] IA gerou resposta na conta pessoal. Encaminhando mensagem gerada como alerta natural para o Master. Chat de origem: ${resolvedChatJid}`);
                    await notifyMaster(responseText);
                    silenceReason = 'Conta pessoal: Alerta enviado em privado para o Master (silêncio mantido com terceiro).';
                } else {
                    // Usa o silenceReason descritivo gerado pelo supervisor (via contextDataUpdate)
                    // Fallback: constrói a razão a partir das memórias episódicas salvas
                    if (!silenceReason) {
                        const episodicMemories: any[] = result.contextData?.newEpisodicMemories || [];
                        if (episodicMemories.length > 0) {
                            const memorySummary = episodicMemories
                                .map((m: any) => typeof m === 'string' ? m : (m?.content || JSON.stringify(m)))
                                .join('; ');
                            silenceReason = `Conta pessoal: Guardei na memória — ${memorySummary}`;
                        } else {
                            silenceReason = 'Conta pessoal: Ignorei — sem fatos relevantes para registrar.';
                        }
                    }
                }
                responseText = '';
            }

            if (!responseText || responseText.trim().toUpperCase() === '[SILENT]') {
                silenceReason = silenceReason || result.contextData?.silenceReason || 'Silêncio intencional mantido pela Bia.';
                logger.info(`[DEBUG] Bia decidiu ficar em silêncio (${silenceReason}) no chat ${resolvedChatJid} (Conta: ${accountName}).`);
                logger.logTriggerOutcome(triggerCtx, {
                    action: 'silent',
                    reason: silenceReason,
                    agentsUsed,
                    durationMs: Date.now() - triggerStartMs,
                });
                clearActiveTrigger(threadId);
            } else {
                logger.logTriggerOutcome(triggerCtx, {
                    action: 'responded',
                    responseText,
                    agentsUsed,
                    durationMs: Date.now() - triggerStartMs,
                });
                clearActiveTrigger(threadId);

                const queueKey = `${accountName}:${resolvedChatJid}`;
                await queueMessageSend(queueKey, async () => {
                    await sock.sendPresenceUpdate('composing', resolvedChatJid);
                    const typingTime = Math.min(Math.max(responseText.length * 30, 1000), 4000);
                    await delay(typingTime);
                    await sock.sendPresenceUpdate('paused', resolvedChatJid);

                    if (shouldBlockMessage(resolvedChatJid, responseText)) {
                        logger.warn(`[WHATSAPP] Resposta final barrada por deduplicação: "${responseText}"`);
                        return;
                    }
                    await sock.sendMessage(resolvedChatJid, { text: responseText });
                });
            }
        });
    } catch (error) {
        logger.error(`[ISOLATED SYSTEM EXECUTION] Erro ao executar mensagem no chat ${resolvedChatJid}:`, error);
        logger.logTriggerOutcome(triggerCtx, {
            action: 'error',
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - triggerStartMs,
        });
        clearActiveTrigger(threadId);
    }
}

export async function injectSystemMessage(
    chatJid: string,
    text: string,
    accountName: string = 'main',
    options: SystemInjectOptions = {}
) {
    const resolvedChatJid = canonicalJid(chatJid);
    const queueKey = `${accountName}:${resolvedChatJid}`;
    const resolvedType = options.triggerType || 'system_inject';
    logger.info(`[SYSTEM INJECT] Enfileirando mensagem isolada na fila ${queueKey} (tipo: ${resolvedType}, routineId: ${options.routineId || 'N/A'}): "${text}"`);

    const currentPromise = systemExecutionQueues.get(queueKey) || Promise.resolve();
    const nextPromise = currentPromise
        .then(async () => {
            await executeIsolatedSystemMessage(resolvedChatJid, text, accountName, options);
        })
        .catch(err => {
            logger.error(`[ISOLATED SYSTEM EXECUTION] Erro na fila ${queueKey}:`, err);
        })
        .finally(() => {
            if (systemExecutionQueues.get(queueKey) === nextPromise) {
                systemExecutionQueues.delete(queueKey);
            }
        });

    systemExecutionQueues.set(queueKey, nextPromise);
}

export async function injectSimulatedTargetMessage(
    targetJid: string,
    text: string
) {
    const accountName = 'main';
    const sock = sockets.get(accountName) || globalSock;
    if (!sock) return;

    const queueKey = `${accountName}:${targetJid}`;
    let queue = chatQueues.get(queueKey);
    if (!queue) {
        queue = {
            accountName: accountName,
            messages: [],
            timeoutId: null,
            isProcessing: false,
            firstMessageTime: Date.now()
        };
        chatQueues.set(queueKey, queue);
    }
    if (queue.messages.length === 0) {
        queue.firstMessageTime = Date.now();
    }

    const msgId = "sim-" + Date.now();
    const timestamp = Date.now();
    const metadata = {
        isGroup: false,
        mentionsBia: false,
        isReplyToBot: true,
        wasReceivedWhileProcessing: false
    };

    const displayName = "Contato Simulado";

    queue.messages.push({
        text: text,
        displayName: displayName,
        messageId: msgId,
        userJid: targetJid,
        timestamp: timestamp,
        metadata: metadata
    });

    savePendingMessage(msgId, queueKey, accountName, targetJid, text, displayName, targetJid, timestamp, metadata).catch(err => 
        logger.error("[PENDING_QUEUE DB] Erro ao salvar msg simulada:", err)
    );

    if (queue.timeoutId) clearTimeout(queue.timeoutId);
    
    // Pequeno delay aleatório entre 2s e 5s para simular digitação
    const delayTime = Math.floor(Math.random() * 3000) + 2000;
    queue.timeoutId = setTimeout(() => {
        processChatQueue(queueKey, sock);
    }, delayTime);
}

export function isSimulatedJid(jid: string): boolean {
    return jid.startsWith('5568') || jid.startsWith('68');
}

export function handleSimulatorIntercept(targetJid: string, text: string) {
    logger.info(`[SIMULATOR] Mensagem interceptada para ${targetJid}: "${text}"`);
    triggerSimulator(targetJid, text).then(async simResponses => {
        for (const resp of simResponses) {
            if (resp.delayMs > 0) {
                await new Promise(r => setTimeout(r, resp.delayMs));
            }
            logger.info(`[SIMULATOR] Resposta gerada: "${resp.text}" (delayMs: ${resp.delayMs})`);
            injectSimulatedTargetMessage(targetJid, resp.text);
        }
    }).catch(err => logger.error("[SIMULATOR] Falha no simulador:", err));
}

const sendQueues = new Map<string, Promise<any>>();

export function queueMessageSend(queueKey: string, sendFn: () => Promise<any>): Promise<any> {
    const currentQueue = sendQueues.get(queueKey) || Promise.resolve();
    const ctx = triggerStorage.getStore(); // Capture context
    
    const nextQueue = currentQueue.then(async () => {
        const execute = async () => {
            try {
                await sendFn();
            } catch (err) {
                logger.error(`[SEND QUEUE ERROR] Error sending message for ${queueKey}:`, err);
            }
        };
        
        if (ctx) {
            await triggerStorage.run(ctx, execute);
        } else {
            await execute();
        }
    });
    sendQueues.set(queueKey, nextQueue);
    return nextQueue;
}

const lastIntermediateTime = new Map<string, number>();

export async function sendIntermediateMessage(chatJidOrThreadId: string, text: string, accountName: string = 'main') {
    if (!text || typeof text !== 'string') {
        return;
    }
    const cleanText = text.trim();
    if (cleanText === "" || cleanText.toLowerCase() === "null" || cleanText.toLowerCase() === "undefined" || cleanText.toUpperCase() === "[SILENT]") {
        return;
    }

    const sock = sockets.get(accountName) || globalSock;
    if (!sock) {
        logger.error(`[INTERMEDIATE MSG] Socket for ${accountName} is not initialized.`);
        return;
    }
    
    // Extrai o JID real se for um threadId (ex: main_5519997064504@s.whatsapp.net_topicId ou JID_topicId)
    let chatJid = chatJidOrThreadId;
    if (chatJidOrThreadId.includes('@')) {
        const match = chatJidOrThreadId.match(/([a-zA-Z0-9.\-_]+@(s\.whatsapp\.net|g\.us|lid))/);
        if (match) {
            chatJid = match[1];
        }
    } else if (chatJidOrThreadId.includes('_')) {
        chatJid = chatJidOrThreadId.split('_')[0];
    }
    const queueKey = `${accountName}:${chatJid}`;
    
    // Previne envio de mensagens intermediárias na conta pessoal
    if (accountName === 'personal') {
        logger.info(`[INTERMEDIATE MSG] Bloqueado envio de "${text}" no chat ${chatJid} (Conta pessoal é apenas leitura).`);
        return;
    }

    const now = Date.now();
    const lastTime = lastIntermediateTime.get(chatJid) || 0;
    if (now - lastTime < 10000) {
        logger.info(`[INTERMEDIATE MSG] Bloqueado envio para ${chatJid} devido ao cooldown de 10s.`);
        return;
    }
    
    if (shouldBlockMessage(chatJid, text)) {
        logger.info(`[INTERMEDIATE MSG] Bloqueado envio duplicado para ${chatJid}: "${text}"`);
        return;
    }
    
    // BEFORE queueMessageSend, update the timer so parallel calls block immediately
    lastIntermediateTime.set(chatJid, now);

    return queueMessageSend(queueKey, async () => {
        logger.info(`[INTERMEDIATE MSG] Enviando mensagem intermediária no chat ${chatJid} (${accountName}): "${text}" (ID da Thread: ${chatJidOrThreadId})`);
        try {
            await sock.sendPresenceUpdate('composing', chatJid);
            const typingTime = Math.min(Math.max(text.length * 30, 1000), 3000);
            await delay(typingTime);
            await sock.sendPresenceUpdate('paused', chatJid);
            
            await sock.sendMessage(chatJid, { text });
        } catch (error) {
            logger.error(`[INTERMEDIATE MSG] Erro ao enviar mensagem para ${chatJid}:`, error);
        }
    });
}

export async function sendPersonalMessageNow(targetJid: string, message: string): Promise<boolean> {
    const personalSock = sockets.get('personal');
    if (!personalSock) {
        logger.error(`[SEND PERSONAL] Socket for personal account is not connected.`);
        return false;
    }

    if (shouldBlockMessage(targetJid, message)) {
        logger.info(`[SEND PERSONAL] Bloqueada mensagem duplicada para ${targetJid}: "${message}"`);
        return false;
    }

    if (isSimulatedJid(targetJid)) {
        logger.info(`[SIMULATOR] Interceptado envio pessoal para ${targetJid}: "${message}"`);
        handleSimulatorIntercept(targetJid, message);
        return true;
    }

    try {
        await personalSock.sendMessage(targetJid, { text: message });
        logger.info(`[SEND PERSONAL] Mensagem enviada diretamente para ${targetJid} (auto-reply habilitado).`);
        return true;
    } catch (e: any) {
        logger.error(`[SEND PERSONAL] Erro ao enviar mensagem para ${targetJid}:`, e);
        return false;
    }
}

export async function sendDirectMessage(accountName: string, targetJid: string, text: string) {
    // Interceptar DDD 68 (ex: 5568999991234 ou 68999991234) para simulação local (Acre)
    if (isSimulatedJid(targetJid)) {
        handleSimulatorIntercept(targetJid, text);
        return true;
    }

    const sock = accountName === 'personal' ? sockets.get('personal') : globalSock;
    if (!sock) {
        logger.error(`[SEND DIRECT] Socket para a conta ${accountName} não inicializado.`);
        return false;
    }

    if (shouldBlockMessage(targetJid, text)) {
        logger.info(`[SEND DIRECT] Bloqueada mensagem direta duplicada para ${targetJid}: "${text}"`);
        return true;
    }

    try {
        logger.info(`[SEND DIRECT] Enviando mensagem direta para ${targetJid} via ${accountName}`);
        await sock.sendMessage(targetJid, { text });
        return true;
    } catch (error) {
        logger.error(`[SEND DIRECT] Erro ao enviar mensagem direta para ${targetJid}:`, error);
        return false;
    }
}

export async function notifyMaster(text: string) {
    if (!globalSock) {
        logger.error("[NOTIFY MASTER] globalSock is not initialized.");
        return;
    }
    
    // We send directly to the master number without queueing as a regular chat
    // to ensure it arrives reliably and immediately.
    const masterJid = MASTER_NUMBER;
    if (shouldBlockMessage(masterJid, text)) {
        logger.info(`[NOTIFY MASTER] Bloqueada notificação duplicada: "${text}"`);
        return;
    }

    try {
        logger.info(`[NOTIFY MASTER] Enviando notificação para o master: "${text}"`);
        const currentTrigger = triggerStorage.getStore();
        if (!currentTrigger) {
            const triggerId = generateTriggerId();
            const triggerCtx: any = {
                triggerId,
                triggerType: 'system_inject',
                threadId: `main_${masterJid}_${triggerId}`,
                chatJid: masterJid,
                chatName: 'Luiz',
                accountName: 'main',
                messageContent: `[Notificação Master] ${text.slice(0, 100)}`,
                startedAt: new Date().toISOString()
            };
            logger.logTriggerEvent(triggerCtx);
            await runWithTriggerContext(triggerCtx, async () => {
                await globalSock.sendMessage(masterJid, { text });
            });
            logger.logTriggerOutcome(triggerCtx, {
                action: 'responded',
                responseText: text
            });
        } else {
            await globalSock.sendMessage(masterJid, { text });
        }
    } catch (error) {
        logger.error(`[NOTIFY MASTER] Erro ao enviar mensagem para o master:`, error);
    }
}

export async function disconnectFromWhatsApp(accountName: string, logout: boolean = true) {
    const sock = sockets.get(accountName);
    if (!sock) {
        return false;
    }
    
    try {
        if (logout) {
            logger.info(`[WHATSAPP] Efetuando logout da conta ${accountName}...`);
            await sock.logout();
        } else {
            logger.info(`[WHATSAPP] Encerrando conexão da conta ${accountName}...`);
            sock.end(undefined);
        }
    } catch (e) {
        logger.error(`[WHATSAPP] Erro ao desconectar ${accountName}:`, e);
    }
    
    sockets.delete(accountName);
    botJids.delete(accountName);
    botLids.delete(accountName);
    return true;
}

export function isWhatsAppConnected(accountName: string): boolean {
    return sockets.has(accountName) || (accountName === 'main' && !!globalSock);
}

export async function getAllGroups(accountName?: string): Promise<{jid: string, name: string}[]> {
    const groupMap = new Map<string, string>();

    // 1. Coleta do cache em memória (groupNameCache)
    for (const [key, name] of groupNameCache.entries()) {
        const [acc, jid] = key.split(':');
        if (!accountName || acc === accountName) {
            if (name) groupMap.set(jid, name);
        }
    }

    // 2. Se o cache estiver vazio para esta conta, busca uma única vez nas conexões ativas
    if (groupMap.size === 0) {
        const targetAccounts = accountName ? [accountName] : ['main', 'personal'];
        for (const acc of targetAccounts) {
            const sock = sockets.get(acc) || (acc === 'main' ? globalSock : null);
            if (sock) {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    for (const g of Object.values(groups) as any[]) {
                        if (g && g.id && g.subject) {
                            groupMap.set(g.id, g.subject);
                            groupNameCache.set(`${acc}:${g.id}`, g.subject);
                            if (acc === 'main') mainGroupJids.add(g.id);
                        }
                    }
                } catch (e) {
                    logger.error(`Erro ao buscar grupos de ${acc}:`, e);
                }
            }
        }
    }

    return Array.from(groupMap.entries()).map(([jid, name]) => ({ jid, name }));
}

export async function connectToWhatsApp(accountName: string = 'main') {
    if (process.env.NODE_ENV === 'test' || process.env.DISABLE_WHATSAPP === 'true' || process.env.SKIP_WHATSAPP === 'true') {
        logger.info(`[WHATSAPP] Conexão ignorada (NODE_ENV=${process.env.NODE_ENV}, DISABLE_WHATSAPP=${process.env.DISABLE_WHATSAPP}).`);
        return;
    }

    // Carrega mapeamentos LID↔número persistidos (essencial para missões: alvo responde via LID)
    loadLidMappings();

    const folderName = `auth_info_baileys_${accountName}`;
    // If it was the original one, we might want to migrate it or just keep auth_info_baileys for main
    const authFolder = accountName === 'main' ? 'auth_info_baileys' : folderName;
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    // Removido o fetchLatestBaileysVersion pois a versão mais recente da API Meta quebra o protobuf do rc13 gerando erro 428 Precondition Required.
    // Utilizaremos a versão default do pacote e uma camuflagem de Browser que passa pelos filtros MD.
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }) as any,
        printQRInTerminal: false,
        markOnlineOnConnect: accountName === 'main',
        browser: ['Ubuntu', 'Chrome', '110.0.0'], // Camuflagem sólida para MD
    });

    // === TRAVA DE TRANSPORTE ABSOLUTA (VAZAMENTO ZERO) ===
    // Garante que NENHUM tráfego de rede seja gerado para contatos simulados na camada base e
    // que a conta pessoal seja EXCLUSIVAMENTE OUVINTE.
    const originalSendMessage = sock.sendMessage.bind(sock);
    const originalSendPresenceUpdate = sock.sendPresenceUpdate.bind(sock);
    const originalReadMessages = sock.readMessages.bind(sock);

    if (accountName === 'personal') {
        sock.sendMessage = async (jid: string, content: any, options?: any) => {
            logger.error(`[TRANSPORT LOCK ABSOLUTO] Tentativa de envio barrada na conta pessoal para ${jid}. A conta pessoal é restrita a SOMENTE LEITURA.`);
            return { key: { remoteJid: jid, fromMe: true, id: `blocked-${Date.now()}` }, message: content };
        };

        sock.sendPresenceUpdate = async (type: any, jid?: string) => {
            logger.error(`[TRANSPORT LOCK ABSOLUTO] Tentativa de sendPresenceUpdate (${type}) barrada na conta pessoal para ${jid}.`);
            return;
        };

        sock.readMessages = async (keys: any[]) => {
            logger.error(`[TRANSPORT LOCK ABSOLUTO] Tentativa de readMessages barrada na conta pessoal.`);
            return;
        };
    } else {
        sock.sendMessage = async (jid: string, content: any, options?: any) => {
            let sentMsg: any = null;
            const text = content?.text || content?.caption || '[Arquivo/Mídia]';
            
            if (isSimulatedJid(jid)) {
                logger.error(`[TRANSPORT LOCK ABSOLUTO] BLOQUEADO envio real (sendMessage) para ${jid}.`);
                // Se o conteúdo for texto, repassamos pro simulador pra não travar o fluxo
                if (content && typeof content.text === 'string') {
                    handleSimulatorIntercept(jid, content.text);
                }
                sentMsg = { 
                    key: { remoteJid: jid, fromMe: true, id: `sim-transport-${Date.now()}` }, 
                    message: content, 
                    messageTimestamp: Math.floor(Date.now() / 1000), 
                    status: 2 
                } as any;
            } else {
                sentMsg = await originalSendMessage(jid, content, options);
            }

            // Log the outbound message to the debugger, automatically tied to current trigger context
            logger.logOutboundMessage(jid, text);

            // Adiciona ao histórico centralizadamente para que notifyMaster, start_mission, etc. nunca fiquem de fora
            if (sentMsg?.key?.id) {
                botSentMessageIds.add(sentMsg.key.id);
                appendMessageToHistory(accountName, jid, {
                    id: sentMsg.key.id,
                    timestamp: Date.now(),
                    sender: "bia",
                    senderName: "Bia",
                    chatName: "Bia",
                    content: text,
                    isFromMe: true
                });
            }

            return sentMsg;
        };

        sock.sendPresenceUpdate = async (type: any, jid?: string) => {
            if (jid && isSimulatedJid(jid)) {
                logger.info(`[TRANSPORT LOCK ABSOLUTO] BLOQUEADO presenceUpdate (${type}) para ${jid}.`);
                return;
            }
            return originalSendPresenceUpdate(type, jid);
        };

        sock.readMessages = async (keys: any[]) => {
            const safeKeys = keys.filter(k => k.remoteJid && !isSimulatedJid(k.remoteJid));
            if (safeKeys.length === 0) return;
            return originalReadMessages(safeKeys);
        };
    }

    sockets.set(accountName, sock);
    if (accountName === 'main') {
        globalSock = sock;
    }

    sock.ev.on('creds.update', saveCreds);

    // Mantém o resolvedor LID↔número atualizado em runtime (Baileys emite quando descobre pares)
    sock.ev.on('lid-mapping.update' as any, (data: any) => {
        try {
            if (data?.lid && data?.pn) {
                registerLidMapping(data.lid, data.pn);
                logger.debug(`[JID RESOLVER] Novo mapeamento LID↔número registrado: ${data.lid} <-> ${data.pn}`);
            }
        } catch (err) {
            logger.error('[JID RESOLVER] Erro ao registrar mapeamento runtime:', err);
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info(`QR Code for account: ${accountName}`);
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const lastDisconnectError = lastDisconnect?.error as any;
            const statusCode = lastDisconnectError?.output?.statusCode;
            const isConflict = statusCode === DisconnectReason.connectionReplaced ||
                               lastDisconnectError?.data?.tag === 'conflict' ||
                               lastDisconnectError?.reasonNode?.tag === 'conflict';

            logger.error(`[WATCHDOG DEBUG] Disconnect error para ${accountName}:`, lastDisconnectError);
            logger.error(`[WATCHDOG DEBUG] statusCode: ${statusCode}, DisconnectReason.loggedOut: ${DisconnectReason.loggedOut}`);
            
            // O código 405 (Method Not Allowed) durante login/registro frequentemente indica rate-limit ou ban temporário do IP/sessão.
            // O código 401 indica que o usuário deslogou a sessão pelo celular.
            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 405;

            if (isConflict) {
                const conflicts = (consecutiveConflicts.get(accountName) || 0) + 1;
                consecutiveConflicts.set(accountName, conflicts);
                logger.warn(`[WATCHDOG] Conflito de sessão detectado para '${accountName}' (tentativa ${conflicts}). Outro processo ou sessão do WhatsApp Web conectou.`);

                if (conflicts >= 2) {
                    logger.error(`[WATCHDOG] Parando reconexão automática da conta '${accountName}' após ${conflicts} conflitos seguidos para evitar loop infinito. Encerrando outra instância ou liberando a sessão.`);
                    return;
                }
            }

            const attempts = (reconnectAttempts.get(accountName) || 0) + 1;
            
            const shouldReconnect = !isLoggedOut;
            
            logger.info(`Conexão fechada (${accountName}). Logged out: ${isLoggedOut}. Reconectando imediatamente: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                reconnectAttempts.set(accountName, attempts);

                let delayMs: number;
                if (statusCode === DisconnectReason.restartRequired) {
                    logger.info(`[WATCHDOG] O WhatsApp solicitou um restart (515) para sincronizar. Reconectando rápido...`);
                    delayMs = 2000; // 2 segundos, não podemos esperar muito aqui!
                } else {
                    // Exponential backoff super conservador: base 30s, fator 1.5, teto em 600s (10 minutos) + jitter (0-2000ms)
                    const baseDelay = isConflict 
                        ? 30000 
                        : Math.min(30000 * Math.pow(1.5, attempts - 1), 600000);
                    const jitter = Math.floor(Math.random() * 2000);
                    delayMs = Math.round(baseDelay + jitter);
                }

                logger.info(`[WATCHDOG] Reconectando ${accountName} em ${Math.round(delayMs / 1000)}s (tentativa ${attempts})...`);
                setTimeout(() => {
                    connectToWhatsApp(accountName).catch(err => logger.error(`[WATCHDOG] Erro ao reconectar ${accountName}:`, err));
                }, delayMs);
            } else {
                reconnectAttempts.delete(accountName);
                consecutiveConflicts.delete(accountName);
                logger.warn(`[WATCHDOG] Sessão de ${accountName} rejeitada criticamente (código ${statusCode}). Limpando credenciais e reiniciando...`);
                // Se foi a principal, avisa o Luiz pelo personal para que ele saiba o que aconteceu
                if (accountName === 'main') {
                    const personalSock = sockets.get('personal');
                    if (personalSock) {
                        try {
                            personalSock.sendMessage(MASTER_NUMBER, { 
                                text: `🚨 *ALERTA CRÍTICO DA BIA* 🚨\n\nA minha conexão principal (main) acabou de cair (Sessão Expirada/Logged Out)!\nEu deletei as credenciais antigas e estou gerando um **NOVO QR CODE** no terminal do servidor agora mesmo.\n\nPor favor, vá até o terminal e escaneie o novo QR Code com o meu celular para me trazer de volta à vida!` 
                            });
                        } catch (e) {
                            logger.error("Erro ao tentar avisar o Master pelo socket personal", e);
                        }
                    }
                }

                // Deleta a pasta de auth
                try {
                    const folderName = accountName === 'main' ? 'auth_info_baileys' : `auth_info_baileys_${accountName}`;
                    const authFolder = path.join(process.cwd(), folderName);
                    if (fs.existsSync(authFolder)) {
                        fs.rmSync(authFolder, { recursive: true, force: true });
                    }
                } catch (e) {
                    logger.error(`Erro ao deletar a pasta de auth de ${accountName}:`, e);
                }

                // Mata o processo para forçar um restart limpo (o Baileys guarda chaves em memória que quebram o login se não reiniciar)
                logger.error(`[WATCHDOG] Encerrando o processo para garantir uma inicialização limpa da conta ${accountName}.`);
                setTimeout(() => process.exit(1), 1000);
            }
        } else if (connection === 'open') {
            logger.info(`WhatsApp (${accountName}) conectado com sucesso!`);
            reconnectAttempts.set(accountName, 0);
            consecutiveConflicts.set(accountName, 0);
            botJids.set(accountName, normalizeJid(sock.user?.id));
            botLids.set(accountName, normalizeJid(sock.user?.lid));

            if (accountName === 'main') {
                refreshMainGroupJids().catch(err =>
                    logger.error(`[WHATSAPP] Erro ao atualizar lista de grupos da conta main no login:`, err)
                );
            }

            recoverPendingMessagesOnStartup(accountName, sock).catch(err =>
                logger.error(`[RECOVERY] Erro ao recuperar mensagens pendentes de ${accountName}:`, err)
            );
        }
    });

    sock.ev.on('presence.update', async (update) => {
        const chatJid = normalizeJid(update.id);
        const presences = update.presences || {};

        let isAnyoneTyping = false;
        for (const participant of Object.keys(presences)) {
            const presence = presences[participant]?.lastKnownPresence;
            if (presence === 'composing') {
                isAnyoneTyping = true;
                break;
            }
        }

        if (isAnyoneTyping) {
            const queueKey = `${accountName}:${chatJid}`;
            const queue = chatQueues.get(queueKey);
            // Só estende o timer se já houver mensagens na fila aguardando processamento e não estiver ativamente processando
            if (queue && queue.messages.length > 0 && !queue.isProcessing && queue.timeoutId) {
                const timeElapsed = Date.now() - queue.firstMessageTime;
                
                // Se ainda não estourou o tempo máximo de espera, adia
                if (timeElapsed < MAX_WAIT_MS) {
                    clearTimeout(queue.timeoutId);
                    // Como a pessoa está digitando, usamos o silêncio de incompletude (INCOMPLETE_SILENCE_THRESHOLD_MS)
                    const delayTime = Math.max(0, Math.min(INCOMPLETE_SILENCE_THRESHOLD_MS, MAX_WAIT_MS - timeElapsed));
                    logger.info(`[DEBOUNCE] Alguém está digitando no chat ${chatJid} (${accountName}). Reagendando fila em ${delayTime}ms.`);
                    queue.timeoutId = setTimeout(() => {
                        processChatQueue(queueKey, sock);
                    }, delayTime);
                }
            }
        }
    });

interface RawMessage {
    msg: any;
}
const rawQueues = new Map<string, { messages: RawMessage[], isProcessing: boolean }>();

async function processRawQueue(chatJid: string, sock: any, accountName: string) {
    const queueKey = `${accountName}:${chatJid}`;
    const queue = rawQueues.get(queueKey);
    if (!queue || queue.isProcessing) return;

    queue.isProcessing = true;
    try {
        while (queue.messages.length > 0) {
            const rawMsg = queue.messages.shift();
            if (!rawMsg) continue;
            
            const msg = rawMsg.msg;
            let userJid = normalizeJid(msg.key.participant || msg.participant || chatJid);
            const myJid = normalizeJid(sock.user?.id || botJids.get(accountName));
            const myLid = normalizeJid(sock.user?.lid || botLids.get(accountName));
            
            if (msg.key.fromMe) {
                userJid = myJid || MASTER_NUMBER;
            }

            const isSelf = chatJid === myJid || chatJid === myLid;
            const isGroup = chatJid.endsWith('@g.us');

            // ===== STATUS/BROADCAST: Ignora atualizações de Status/Stories do WhatsApp =====
            if (isBroadcastJid(chatJid)) {
                logger.info(`[IGNORED] Mensagem de broadcast/status (${chatJid}) ignorada no processRawQueue.`);
                continue;
            }

            // ===== MENSAGENS DA BIA: Ignora qualquer mensagem enviada pela própria Bia =====
            if (isMessageFromBia(userJid)) {
                logger.info(`[IGNORED] Mensagem de ${userJid} ignorada no processRawQueue pois foi enviada pela própria Bia (Conta: ${accountName}).`);
                continue;
            }

            // ===== GRUPOS DA CONTA MAIN NA PERSONAL: Ignora no personal grupos que a Bia (main) já participa =====
            if (accountName === 'personal' && isGroup) {
                if (mainGroupJids.has(chatJid)) {
                    logger.info(`[IGNORED] Mensagem do grupo ${chatJid} ignorada na conta personal pois a Bia (main) já faz parte do grupo.`);
                    continue;
                }
            }

            const docMsg = msg.message?.documentMessage || msg.message?.documentWithCaptionMessage?.message?.documentMessage;
            let text = msg.message?.conversation || 
                         msg.message?.extendedTextMessage?.text || 
                         msg.message?.imageMessage?.caption || 
                         msg.message?.videoMessage?.caption ||
                         docMsg?.caption;

            // ===== CHATS IGNORADOS: Se estiver na lista de ignorados, descarta =====
            let cachedGroupName = groupNameCache.get(`${accountName}:${chatJid}`);
            if (isGroup && !cachedGroupName) {
                cachedGroupName = await getChatName(sock, chatJid, accountName);
            }
            if (isGroupIgnored(chatJid, cachedGroupName)) {
                logger.info(`[IGNORED] Mensagem de chat ignorado: ${chatJid} (${cachedGroupName || 'sem nome em cache'})`);
                continue;
            }

            if (msg.message?.audioMessage) {
                const audioSeconds = msg.message?.audioMessage?.seconds || 0;
                if (audioSeconds > 300) {
                    logger.warn(`[AUDIO] Áudio de ${chatJid} possui ${audioSeconds}s (excede o limite de 5 min). Transcrição ignorada.`);
                    text = `[Áudio de ${Math.round(audioSeconds / 60)} min recebido — não transcrito por exceder o limite máximo de 5 minutos]`;
                } else {
                    try {
                        logger.info(`[AUDIO] Baixando áudio de ${chatJid} (${audioSeconds}s)...`);
                        const buffer = (await downloadMediaMessage(
                            msg,
                            'buffer',
                            { },
                            { 
                                logger: logger as any,
                                reuploadRequest: sock.updateMediaMessage
                            }
                        )) as Buffer;
                    
                    logger.info(`[AUDIO] Áudio baixado, iniciando transcrição via Groq...`);
                    const audioFile = await toFile(buffer, 'audio.ogg', { type: 'audio/ogg' });
                    
                    const transcription = await groqClient.audio.transcriptions.create({
                        file: audioFile,
                        model: 'whisper-large-v3-turbo',
                        prompt: 'O áudio está em português. Por favor transcreva-o da melhor forma possível.',
                        response_format: 'text'
                    });
                    
                    const transcricao = typeof transcription === 'string' ? transcription : (transcription as any).text;
                    
                    if (transcricao) {
                        text = `[Áudio transcrito]: ${transcricao}`;
                        logger.info(`[AUDIO] Transcrição concluída: "${transcricao}"`);
                    } else {
                        logger.warn(`[AUDIO] Transcrição retornou vazia.`);
                    }
                    } catch (err) {
                        logger.error(`[AUDIO] Erro ao processar áudio:`, err);
                        continue;
                    }
                }
            }

            if (msg.message?.imageMessage) {
                try {
                    logger.info(`[IMAGE] Baixando imagem de ${chatJid}...`);
                    const buffer = (await downloadMediaMessage(
                        msg,
                        'buffer',
                        { },
                        { 
                            logger: logger as any,
                            reuploadRequest: sock.updateMediaMessage
                        }
                    )) as Buffer;
                    
                    logger.info(`[IMAGE] Imagem baixada, iniciando análise via Gemini...`);
                    
                    const { GoogleGenAI } = await import('@google/genai');
                    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
                    
                    let response;
                    const attempts = 3;
                    for (let i = 0; i < attempts; i++) {
                        try {
                            response = await ai.models.generateContent({
                                model: 'gemini-flash-lite-latest',
                                contents: [
                                    {
                                        role: 'user',
                                        parts: [
                                            { text: 'Descreva esta imagem de forma detalhada para que eu entenda o contexto da conversa. Se houver texto importante, transcreva-o.' },
                                            { inlineData: { data: buffer.toString("base64"), mimeType: msg.message?.imageMessage?.mimetype || 'image/jpeg' } }
                                        ]
                                    }
                                ]
                            });
                            break; // Sucesso
                        } catch (err) {
                            if (i === attempts - 1) throw err;
                            logger.warn(`[IMAGE] Tentativa ${i + 1} da API do Gemini falhou. Tentando novamente em 2 segundos...`, err);
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        }
                    }
                    
                    const description = response ? response.text : undefined;
                    const originalCaption = msg.message?.imageMessage?.caption || '';
                    
                    if (description) {
                        text = `[Imagem recebida]: A IA descreveu a imagem como: "${description}"`;
                        if (originalCaption) {
                            text += `\n[Legenda original]: "${originalCaption}"`;
                        }
                        logger.info(`[IMAGE] Análise concluída: "${description}"`);
                    } else {
                        logger.warn(`[IMAGE] A análise retornou vazia.`);
                    }
                } catch (err) {
                    logger.error(`[IMAGE] Erro ao processar imagem:`, err);
                    continue;
                }
            }

            if (docMsg) {
                try {
                    const fileName = docMsg.fileName || 'arquivo';
                    const mimetype = docMsg.mimetype || '';
                    const caption = docMsg.caption || '';
                    logger.info(`[DOCUMENT] Baixando documento de ${chatJid}: "${fileName}" (${mimetype})...`);

                    const buffer = (await downloadMediaMessage(
                        msg,
                        'buffer',
                        {},
                        {
                            logger: logger as any,
                            reuploadRequest: sock.updateMediaMessage
                        }
                    )) as Buffer;

                    if (buffer) {
                        const fileExt = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')).toLowerCase() : '';
                        const isTextLike = 
                            ['.csv', '.txt', '.json', '.md', '.tsv', '.log', '.xml', '.html', '.css', '.js', '.ts', '.py', '.sh', '.yaml', '.yml'].includes(fileExt) ||
                            mimetype.startsWith('text/') ||
                            mimetype.includes('csv') ||
                            mimetype.includes('json') ||
                            mimetype.includes('javascript') ||
                            mimetype.includes('xml');

                        if (isTextLike) {
                            let contentStr = buffer.toString('utf-8');
                            const maxChars = 30000;
                            let truncatedNotice = '';
                            if (contentStr.length > maxChars) {
                                truncatedNotice = `\n... [Conteúdo do arquivo foi truncado aos 30.000 caracteres de um total de ${contentStr.length}]`;
                                contentStr = contentStr.substring(0, maxChars);
                            }

                            text = `[Arquivo/Documento recebido: "${fileName}"]:\n--- CONTEÚDO DO ARQUIVO ---\n${contentStr}${truncatedNotice}\n--- FIM DO ARQUIVO ---`;
                            if (caption) {
                                text += `\n[Legenda do arquivo]: "${caption}"`;
                            }
                            logger.info(`[DOCUMENT] Arquivo de texto/CSV "${fileName}" processado com sucesso (${buffer.length} bytes).`);
                        } else if (mimetype === 'application/pdf' || fileExt === '.pdf') {
                            logger.info(`[DOCUMENT] Documento PDF "${fileName}" baixado. Analisando via Gemini...`);
                            try {
                                const { GoogleGenAI } = await import('@google/genai');
                                const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
                                const response = await ai.models.generateContent({
                                    model: 'gemini-flash-lite-latest',
                                    contents: [
                                        {
                                            role: 'user',
                                            parts: [
                                                { text: 'Extraia e resuma o conteúdo principal deste documento PDF de forma estruturada para contextualizar a conversa.' },
                                                { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } }
                                            ]
                                        }
                                    ]
                                });
                                const pdfSummary = response?.text;
                                if (pdfSummary) {
                                    text = `[Documento PDF recebido: "${fileName}"]:\nConteúdo do PDF:\n${pdfSummary}`;
                                    if (caption) {
                                        text += `\n[Legenda do arquivo]: "${caption}"`;
                                    }
                                    logger.info(`[DOCUMENT] Análise do PDF "${fileName}" concluída via Gemini.`);
                                } else {
                                    text = `[Documento PDF recebido: "${fileName}"] (não foi possível extrair o texto automaticamente).`;
                                    if (caption) text += `\n[Legenda]: "${caption}"`;
                                }
                            } catch (pdfErr) {
                                logger.error(`[DOCUMENT] Erro ao analisar PDF via Gemini:`, pdfErr);
                                text = `[Documento PDF recebido: "${fileName}"]`;
                                if (caption) text += `\n[Legenda]: "${caption}"`;
                            }
                        } else {
                            text = `[Documento/Arquivo anexado: "${fileName}" (Tipo: ${mimetype || 'binário'})]`;
                            if (caption) {
                                text += `\n[Legenda do arquivo]: "${caption}"`;
                            }
                            logger.info(`[DOCUMENT] Documento binário "${fileName}" recebido.`);
                        }
                    }
                } catch (err) {
                    logger.error(`[DOCUMENT] Erro ao processar documento:`, err);
                    if (!text && docMsg.caption) {
                        text = `[Arquivo recebido com erro no download]: ${docMsg.caption}`;
                    } else if (!text) {
                        continue;
                    }
                }
            }

            // Se for mensagem enviada por mim
            if (msg.key.fromMe) {
                const msgId = msg.key.id;
                // Se foi a própria Bia que enviou, descarta
                if (msgId && botSentMessageIds.has(msgId)) {
                    botSentMessageIds.delete(msgId);
                    continue;
                }
                // Na conta MAIN, ignoramos mensagens enviadas pelo próprio usuário (salvo auto-conversa)
                // Na conta PERSONAL, queremos escutar o que o usuário digita para os outros.
                if (accountName === 'main' && !isSelf) {
                    continue;
                }
            }

            if (!text) continue;



            // --- GERENCIAMENTO DE GRUPOS IGNORADOS ---
            if (isGroup && MASTER_JIDS.includes(userJid) && accountName === 'main') {
                const cmd = isGroupManagementCommand(text);
                if (cmd.action === 'ignore' || cmd.action === 'unignore') {
                    const triggerId = generateTriggerId();
                    const groupName = await getChatName(sock, chatJid, accountName) || chatJid;
                    const triggerCtx: any = {
                        triggerId,
                        triggerType: 'whatsapp_message',
                        threadId: `${accountName}_${chatJid}_${triggerId}`,
                        chatJid,
                        chatName: groupName,
                        senderJid: userJid,
                        senderName: msg.pushName || 'Luiz',
                        accountName,
                        messageContent: text,
                        startedAt: new Date().toISOString(),
                        metadata: { isGroup: true }
                    };
                    logger.logTriggerEvent(triggerCtx);
                    const responseText = cmd.action === 'ignore'
                        ? '✅ Entendido! Não vou mais responder neste grupo. Se precisar de mim, é só me chamar no privado. 😊'
                        : '✅ Pronto! Voltei a prestar atenção neste grupo. 😊';
                    await runWithTriggerContext(triggerCtx, async () => {
                        if (cmd.action === 'ignore') {
                            addIgnoredGroup(chatJid, groupName);
                        } else {
                            removeIgnoredGroup(chatJid);
                        }
                        await sock.sendMessage(chatJid, { text: responseText });
                    });
                    logger.logTriggerOutcome(triggerCtx, {
                        action: 'responded',
                        responseText
                    });
                    continue;
                }
            }
            // ----------------------------------------------

            // --- PROCESSAMENTO DE COMANDOS DETERMINÍSTICOS (/comando) ---
            if (isCommand(text)) {
                const triggerId = generateTriggerId();
                const chatName = (await getChatName(sock, chatJid, accountName)) || chatJid;
                const senderName = msg.pushName || (msg.key.fromMe ? 'Luiz' : userJid.split('@')[0]);
                const triggerCtx: any = {
                    triggerId,
                    triggerType: 'whatsapp_message',
                    threadId: `${accountName}_${chatJid}_${triggerId}`,
                    chatJid,
                    chatName,
                    senderJid: userJid,
                    senderName,
                    accountName,
                    messageContent: text,
                    startedAt: new Date().toISOString(),
                    metadata: { isGroup }
                };

                logger.logTriggerEvent(triggerCtx);

                let handled = false;
                await runWithTriggerContext(triggerCtx, async () => {
                    handled = await handleCommand({
                        text,
                        chatJid,
                        userJid,
                        accountName,
                        isGroup,
                        sock,
                        clearQueue: () => {
                            const q = chatQueues.get(queueKey);
                            if (q) q.messages = [];
                        }
                    });
                });

                if (handled) {
                    logger.logTriggerOutcome(triggerCtx, {
                        action: 'responded',
                        responseText: `Comando ${text.split(/\s+/)[0]} executado.`
                    });
                    continue; // Ignora enfileiramento e invocação da IA
                }
            }
            // ----------------------------------------------

            // Subscreve para receber atualizações de presença deste chat (uma única vez por chat/sessão)
            const presenceKey = `${accountName}:${chatJid}`;
            if (!subscribedPresenceJids.has(presenceKey)) {
                try {
                    await sock.presenceSubscribe(chatJid);
                    subscribedPresenceJids.add(presenceKey);
                } catch (err) {
                    console.warn(`[DEBOUNCE] Erro ao assinar presença para ${chatJid}:`, err);
                }
            }

            try {
                let displayName = msg.pushName || userJid.split('@')[0];
                if (msg.key.fromMe) {
                    displayName = "Luiz";
                } else if (msg.pushName) {
                    updateContactPushName(canonicalJid(userJid), msg.pushName).catch(err => 
                        logger.error(`Erro ao salvar pushName do contato ${userJid}:`, err)
                    );
                }
                
                // Determina se a mensagem cita/responde ao bot
                const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
                const isReplyToBot = quotedParticipant && (
                    normalizeJid(quotedParticipant) === myJid || 
                    normalizeJid(quotedParticipant) === myLid
                );
                // Verifica menções à Bia no texto (case-insensitive) - na conta pessoal, NUNCA considera que foi mencionada
                const mentionsBia = accountName === 'main' ? text.toLowerCase().includes('bia') : false;

                logger.info(`[DEBUG] Recebido de ${chatJid} (${isGroup ? 'Grupo' : 'Privado'}): "${text}". Adicionando à fila.`);

                let queue = chatQueues.get(queueKey);
                const isProcessing = queue ? queue.isProcessing : false;

                if (!queue) {
                    queue = {
                        accountName: accountName,
                        messages: [],
                        timeoutId: null,
                        isProcessing: false,
                        firstMessageTime: Date.now()
                    };
                    chatQueues.set(queueKey, queue);
                }

                if (queue.messages.length === 0) {
                    queue.firstMessageTime = Date.now();
                }

                const isPersonalAccount = accountName === 'personal';

                // Guardrail baseado no volume de caracteres para estimar limite de tokens
                const currentChars = queue.messages.reduce((acc, m) => acc + m.text.length, 0);
                const charLimit = isPersonalAccount ? 15000 : 8000; // ~4000 tokens para a conta pessoal
                
                if (currentChars >= charLimit || (!isPersonalAccount && queue.messages.length >= 20)) {
                    if (isPersonalAccount) {
                        logger.warn(`[GUARDRAIL] Volume do chat pessoal atingiu ${currentChars} caracteres para ${queueKey}. Processando lote antecipadamente!`);
                        if (queue.timeoutId) {
                            clearTimeout(queue.timeoutId);
                            queue.timeoutId = null;
                        }
                        processChatQueue(queueKey, sock);
                        queue.firstMessageTime = Date.now();
                    } else {
                        logger.warn(`[GUARDRAIL] Fila de mensagens atingiu o limite para ${queueKey}. Mensagem ignorada.`);
                        continue;
                    }
                }

                const msgId = msg.key.id || `sys-${Date.now()}`;
                const timestamp = Date.now();
                const metadata = {
                    isGroup,
                    mentionsBia,
                    isReplyToBot,
                    wasReceivedWhileProcessing: isProcessing
                };

                queue.messages.push({
                    text: text,
                    displayName: displayName,
                    messageId: msgId,
                    userJid: userJid,
                    timestamp: timestamp,
                    metadata: metadata
                });

                savePendingMessage(msgId, queueKey, accountName, chatJid, text, displayName, userJid, timestamp, metadata).catch(err => 
                    logger.error("[PENDING_QUEUE DB] Erro ao salvar mensagem recebida no SQLite:", err)
                );

                // Auto-resolução inteligente de follow-ups ao receber retorno do contato
                if (!msg.key.fromMe) {
                    autoResolveFollowUpsForChat(chatJid, userJid, displayName, text).catch(err =>
                        logger.error("[FOLLOWUP AUTO-RESOLVE] Erro ao auto-resolver follow-ups:", err)
                    );
                }
                
                appendMessageToHistory(accountName, chatJid, {
                    id: msgId,
                    timestamp: timestamp,
                    sender: userJid,
                    senderName: displayName,
                    chatName: isGroup ? await getChatName(sock, chatJid, accountName) : displayName,
                    content: text,
                    isFromMe: !!msg.key.fromMe
                });

                if (queue.timeoutId) {
                    clearTimeout(queue.timeoutId);
                }

                const silenceDelay = getSilenceDelayForMessage(text);
                queue.lastSilenceDelay = silenceDelay;

                const timeElapsed = Date.now() - queue.firstMessageTime;
                let delayTime = 0;

                if (accountName === 'personal') {
                    // Lógica regressiva baseada no tempo de duração da sessão
                    let silenceThresholdMs = 30 * 60 * 1000; // Padrão: 30 minutos
                    if (timeElapsed > 4 * 60 * 60 * 1000) {
                        silenceThresholdMs = 5 * 60 * 1000; // > 4h: 5 minutos
                    } else if (timeElapsed > 2 * 60 * 60 * 1000) {
                        silenceThresholdMs = 15 * 60 * 1000; // > 2h: 15 minutos
                    }
                    delayTime = silenceThresholdMs;
                    logger.info(`[DEBOUNCE] Chat pessoal ${queueKey}. Sessão ativa há ${Math.round(timeElapsed/60000)}min. Agendado para proc após silêncio de ${silenceThresholdMs/60000}min.`);
                } else {
                    delayTime = Math.max(0, Math.min(silenceDelay, MAX_WAIT_MS - timeElapsed));
                    logger.info(`[DEBOUNCE] Tempo decorrido desde a primeira mensagem: ${timeElapsed}ms. Reagendando fila em ${delayTime}ms. (Delay recomendado: ${silenceDelay}ms)`);
                }

                queue.timeoutId = setTimeout(() => {
                    processChatQueue(queueKey, sock);
                }, delayTime);

            } catch (error) {
                logger.error(`Erro ao enfileirar mensagem na fila ${queueKey}:`, error);
            }
        }
    } finally {
        queue.isProcessing = false;
        if (queue.messages.length === 0) {
            rawQueues.delete(queueKey);
        }
    }
}

    sock.ev.on('groups.upsert', (groups) => {
        for (const group of groups) {
            if (accountName === 'main') {
                mainGroupJids.add(group.id);
            }
            if (group.subject) {
                groupNameCache.set(`${accountName}:${group.id}`, group.subject);
            }
        }
    });

    sock.ev.on('groups.update', (updates) => {
        for (const update of updates) {
            if (update.id && update.subject) {
                groupNameCache.set(`${accountName}:${update.id}`, update.subject);
            }
        }
    });

    sock.ev.on('group-participants.update', (update) => {
        if (accountName === 'main') {
            const myJid = botJids.get('main');
            const myLid = botLids.get('main');
            const isMe = update.participants.some(p => {
                const pJid = typeof p === 'string' ? p : (p as any)?.id;
                return pJid === myJid || pJid === myLid;
            });
            
            if (isMe) {
                if (update.action === 'add' || update.action === 'promote') {
                    mainGroupJids.add(update.id);
                } else if (update.action === 'remove') {
                    mainGroupJids.delete(update.id);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            const chatJid = normalizeJid(msg.key.remoteJid);
            const userJid = normalizeJid(msg.key.participant || msg.participant || chatJid);

            // Ignora postagens de Status/Stories e Broadcasts do WhatsApp (ex: status@broadcast)
            if (isBroadcastJid(chatJid)) continue;

            // Ignora as próprias mensagens enviadas no socket da Bia (main) para evitar self-loops,
            // mas preserva no socket 'personal' para gravar o histórico do que o usuário humano respondeu.
            if (msg.key.fromMe && accountName === 'main') continue;

            // Ignora TODAS as mensagens enviadas pela própria Bia (main JID / LID) em qualquer socket
            if (isMessageFromBia(userJid)) {
                logger.info(`[IGNORED] Mensagem enviada pela própria Bia (${userJid}) recebida na conta ${accountName}. Descartando.`);
                continue;
            }

            // Envia recibo de leitura apenas na conta da própria Bia (main)
            if (accountName === 'main' && msg.key) {
                sock.readMessages([msg.key]).catch(err => {
                    logger.error(`[READ RECEIPT] Erro ao marcar mensagem como lida:`, err);
                });
            }

            // Mapeia grupos nos quais a conta main está ativa
            if (accountName === 'main' && chatJid.endsWith('@g.us')) {
                mainGroupJids.add(chatJid);
            }

            // Previne monitoramento duplicado na conta personal
            if (accountName === 'personal') {
                const mainJid = botJids.get('main');
                const mainLid = botLids.get('main');
                
                // 1. Previne monitorar a conversa direta do Luiz com a própria Bia (main)
                if ((mainJid && chatJid === mainJid) || (mainLid && chatJid === mainLid)) continue;

                // 2. Se for grupo e a conta MAIN já fizer parte desse grupo, a conta personal ignora!
                if (chatJid.endsWith('@g.us')) {
                    if (mainGroupJids.has(chatJid)) {
                        logger.info(`[IGNORED] Mensagem de grupo (${chatJid}) ignorada na conta personal pois a Bia (main) já faz parte do grupo.`);
                        continue;
                    }
                }
            }

            const queueKey = `${accountName}:${chatJid}`;
            
            let queue = rawQueues.get(queueKey);
            if (!queue) {
                queue = { messages: [], isProcessing: false };
                rawQueues.set(queueKey, queue);
            }
            queue.messages.push({ msg });
            
            // Inicia o processamento sem bloquear o loop de recebimento do Baileys
            processRawQueue(chatJid, sock, accountName).catch(err => {
                logger.error(`[RAW QUEUE] Erro ao processar rawQueue para ${queueKey}:`, err);
            });
        }
    });
}

export function _setGlobalSockForTest(sock: any) {
    globalSock = sock;
}

export function _popSimulatedMessages() {
    const messages: any[] = [];
    for (const [key, queue] of chatQueues.entries()) {
        if (queue.messages.length > 0) {
            messages.push(...queue.messages);
            queue.messages = [];
        }
    }
    return messages;
}
