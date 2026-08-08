import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { agent } from '../graph/workflow.js';
import { logger, generateTriggerId, setActiveTrigger, clearActiveTrigger, getActiveTrigger, runWithTriggerContext, loggerCallbackHandler, triggerStorage } from '../utils/logger.js';
import { resolveTopicForMessage } from '../utils/topicBroker.js';
import { isTrustedChat, MASTER_NUMBER, MASTER_JIDS, consumeApprovalToken, addTrustedChat } from '../memory/security.js';
import { isGroupIgnored, addIgnoredGroup, removeIgnoredGroup, isGroupManagementCommand } from '../config/ignoredGroups.js';
import { appendMessageToHistory } from '../memory/chatHistory.js';
import { isCommand, handleCommand, getChatModelOverride } from '../commands/commandRouter.js';
import { savePendingMessage, getAllPendingMessages, clearPendingMessagesForQueue } from '../memory/pendingQueue.js';
import { hasActiveMissionForTarget, getActiveMissionsForTarget, getActiveMissionsForChat, getRecentMissionsForChat } from '../memory/missions.js';
import { loadLidMappings, registerLidMapping, jidsMatch } from '../utils/jidResolver.js';
import OpenAI, { toFile } from 'openai';
import { triggerSimulator } from '../utils/simulator.js';

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
    pendingInjectMetas?: SystemInjectOptions[];
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
        const pending = await getAllPendingMessages();
        const accountPending = pending.filter(p => p.accountName === accountName);
        if (accountPending.length > 0) {
            logger.info(`[RECOVERY] Encontradas ${accountPending.length} mensagens pendentes para a conta ${accountName}. Reagendando processamento...`);
            for (const item of accountPending) {
                const queueKey = item.queueKey;
                let queue = chatQueues.get(queueKey);
                if (!queue) {
                    queue = {
                        accountName: item.accountName,
                        messages: [],
                        timeoutId: null,
                        isProcessing: false,
                        firstMessageTime: Date.now()
                    };
                    chatQueues.set(queueKey, queue);
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
    const [user, server] = jid.split('@');
    const cleanUser = jid.includes(':') ? user.split(':')[0] + '@' + server : jid;
    return cleanUser;
}

// Conjunto em memória para rastrear os JIDs dos grupos dos quais a conta main (Bia) faz parte
const mainGroupJids = new Set<string>();

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

    const [accountName, chatJid] = queueKey.split(':');

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

    // Copia e esvazia a fila de mensagens e lê metadados de inject se presentes
    const messagesToProcess = [...queue.messages];
    queue.messages = [];
    const injectMetas = queue.pendingInjectMetas ? [...queue.pendingInjectMetas] : [];
    queue.pendingInjectMetas = [];
    const injectMeta = injectMetas.length > 0 ? injectMetas[injectMetas.length - 1] : undefined;

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
        let combinedText = messagesToProcess.map(m => {
            return isGroup ? `${m.displayName}: ${m.text}` : m.text;
        }).join("\n---\n");

        const maxChars = isPersonalGroup ? 30000 : 2000;
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

        const { topicId, title } = await resolveTopicForMessage(chatJid, combinedText, accountName);
        const threadId = `${chatJid}_${topicId}`;

        logger.info(`[DEBOUNCE] Direcionando mensagens para o assunto: "${title}" (Thread: ${threadId})`);

        let addedWarning = false;
        const humanMessages = messagesToProcess.map(
            m => {
                const dateStr = new Date(m.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                let msgContent = isGroup ? `${m.displayName}: ${m.text}` : m.text;
                if (m.metadata?.wasReceivedWhileProcessing) {
                    if (!addedWarning) {
                        msgContent = `[⚠️ As mensagens a seguir foram enviadas enquanto você formulava a resposta anterior]\n${msgContent}`;
                        addedWarning = true;
                    }
                }
                return new HumanMessage({ content: `[${dateStr}] ${msgContent}`, name: m.displayName });
            }
        );

        const isTrusted = await isTrustedChat(chatJid);
        const lastMsg = messagesToProcess[messagesToProcess.length - 1];
        const lastMsgUserJid = lastMsg?.userJid || chatJid;
        const senderName = lastMsg?.displayName || "Desconhecido";
        
        let chatName = chatJid;
        if (isGroup) {
            chatName = await getChatName(sock, chatJid, accountName) || "Grupo Desconhecido";
        }

        // ── TRIGGER: register the generating event before invoking the agent ──
        // Use inject metadata if this queue was triggered by a cron/system inject;
        // otherwise it's a regular WhatsApp message.
        const triggerId = generateTriggerId();
        const resolvedTriggerType = injectMeta?.triggerType ?? 'whatsapp_message';
        resolvedThreadId = threadId;
        const triggerCtx = setActiveTrigger(threadId, {
            triggerId,
            triggerType: resolvedTriggerType,
            threadId,
            chatJid,
            chatName,
            senderJid: injectMeta ? undefined : lastMsgUserJid,
            senderName: injectMeta ? 'SISTEMA' : senderName,
            accountName,
            messageContent: combinedText,
            metadata: {
                isGroup,
                mentionsBia: messagesToProcess.some(m => m.metadata?.mentionsBia),
                isReplyToBot: messagesToProcess.some(m => m.metadata?.isReplyToBot),
                wasReceivedWhileProcessing: messagesToProcess.some(m => m.metadata?.wasReceivedWhileProcessing),
            },
            routineId: injectMeta?.routineId,
            routinePrompt: injectMeta?.routinePrompt,
        });
        activeTriggerCtx = triggerCtx;
        logger.logTriggerEvent(triggerCtx);
        triggerStartMs = Date.now();

        await runWithTriggerContext(triggerCtx, async () => {
            const config = { 
                configurable: { thread_id: threadId },
                metadata: { threadId: threadId, agentName: "graph" },
                callbacks: [loggerCallbackHandler],
                recursionLimit: 25
            };
            const activeMissions = await getActiveMissionsForChat(chatJid);
            const recentMissions = await getRecentMissionsForChat(chatJid, 10);
            const result = await agent.invoke({
                messages: humanMessages,
                contextData: { 
                    active_topic_title: title,
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
                    executionLog: [],
                    executedTools: [],
                    activePlan: []
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
            
            if (agentsUsed.includes("missionAgent") && isTargetChat) {
                if (responseText && responseText.trim().toUpperCase() !== '[SILENT]') {
                    logger.info(`[WHATSAPP] missionAgent atuou em chat de alvo. Suprimindo resposta textual bruta para evitar vazamentos (use send_message_to_target).`);
                    responseText = '';
                }
            } else if (missionToolsUsed && responseText && responseText.trim().toUpperCase() !== '[SILENT]') {
                logger.info(`[WHATSAPP] missionAgent já tratou a comunicação via tools. Suprimindo resposta do pipeline para ${chatJid}.`);
                responseText = '';
            }

            // Bloqueio de segurança para a conta pessoal (READ-ONLY)
            if (accountName === 'personal') {
                if (responseText && responseText.trim().toUpperCase() !== '[SILENT]') {
                    logger.info(`[SECURITY] IA tentou responder na conta pessoal. Redirecionando alerta para o Master. Chat: ${chatJid}`);
                    const chatNameForNotice = chatName && chatName !== chatJid ? chatName : chatJid.split('@')[0];
                    const notificationText = `🚨 *Bia Detectou Algo (Conta Pessoal)*\n\nNo chat com *${chatNameForNotice}*, eu decidi que você deveria saber disso/responder:\n\n"${responseText}"`;
                    await notifyMaster(notificationText);
                }
                responseText = ''; // Força silêncio absoluto no socket da conta pessoal
            }

            // Se a resposta for '[SILENT]' ou vazia/não-AIMessage, não enviamos nenhuma mensagem de volta
            if (!responseText || responseText.trim().toUpperCase() === '[SILENT]') {
                logger.info(`[DEBUG] Bia decidiu ficar em silêncio ou não gerou resposta de IA no chat ${chatJid} (Conta: ${accountName}).`);
                // Log trigger outcome: silent
                logger.logTriggerOutcome(triggerCtx, {
                    action: 'silent',
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
}

export async function injectSystemMessage(
    chatJid: string,
    text: string,
    accountName: string = 'main',
    options: SystemInjectOptions = {}
) {
    const sock = sockets.get(accountName) || globalSock;
    if (!sock) {
        logger.error(`[SYSTEM INJECT] Socket for ${accountName} is not initialized.`);
        return;
    }
    
    const queueKey = `${accountName}:${chatJid}`;
    const resolvedType = options.triggerType || 'system_inject';
    logger.info(`[SYSTEM INJECT] Injetando mensagem na fila ${queueKey} (tipo: ${resolvedType}): "${text}"`);
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

    if (!queue.pendingInjectMetas) {
        queue.pendingInjectMetas = [];
    }
    queue.pendingInjectMetas.push({
        triggerType: resolvedType,
        routineId: options.routineId,
        routinePrompt: options.routinePrompt,
    });

    const msgId = "sys-" + Date.now();
    const timestamp = Date.now();
    const isGroup = chatJid.endsWith('@g.us');
    const metadata = {
        isGroup,
        mentionsBia: false,
        isReplyToBot: false,
        wasReceivedWhileProcessing: false
    };

    queue.messages.push({
        text: text,
        displayName: "SISTEMA",
        messageId: msgId,
        userJid: chatJid,
        timestamp: timestamp,
        metadata: metadata
    });

    savePendingMessage(msgId, queueKey, accountName, chatJid, text, "SISTEMA", chatJid, timestamp, metadata).catch(err => 
        logger.error("[PENDING_QUEUE DB] Erro ao salvar mensagem injetada no SQLite:", err)
    );

    if (queue.timeoutId) {
        clearTimeout(queue.timeoutId);
    }

    const silenceDelay = getSilenceDelayForMessage(text);
    queue.lastSilenceDelay = silenceDelay;

    const timeElapsed = Date.now() - queue.firstMessageTime;
    const delayTime = Math.max(0, Math.min(silenceDelay, MAX_WAIT_MS - timeElapsed));

    queue.timeoutId = setTimeout(() => {
        processChatQueue(queueKey, sock);
    }, delayTime);
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
    const sock = sockets.get(accountName) || globalSock;
    if (!sock) {
        logger.error(`[INTERMEDIATE MSG] Socket for ${accountName} is not initialized.`);
        return;
    }
    
    // Extrai o JID real se for um threadId (JID_topicId)
    const chatJid = chatJidOrThreadId.includes('_') ? chatJidOrThreadId.split('_')[0] : chatJidOrThreadId;
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
        await globalSock.sendMessage(masterJid, { text });
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
    // Garante que NENHUM tráfego de rede seja gerado para contatos simulados na camada base
    const originalSendMessage = sock.sendMessage.bind(sock);
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

    const originalSendPresenceUpdate = sock.sendPresenceUpdate.bind(sock);
    sock.sendPresenceUpdate = async (type: any, jid?: string) => {
        if (jid && isSimulatedJid(jid)) {
            logger.info(`[TRANSPORT LOCK ABSOLUTO] BLOQUEADO presenceUpdate (${type}) para ${jid}.`);
            return;
        }
        return originalSendPresenceUpdate(type, jid);
    };

    const originalReadMessages = sock.readMessages.bind(sock);
    sock.readMessages = async (keys: any[]) => {
        const safeKeys = keys.filter(k => k.remoteJid && !isSimulatedJid(k.remoteJid));
        if (safeKeys.length === 0) return;
        return originalReadMessages(safeKeys);
    };

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
            const userJid = normalizeJid(msg.key.participant || msg.participant || chatJid);
            const myJid = normalizeJid(sock.user?.id || botJids.get(accountName));
            const myLid = normalizeJid(sock.user?.lid || botLids.get(accountName));
            const isSelf = chatJid === myJid || chatJid === myLid;
            const isGroup = chatJid.endsWith('@g.us');

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

            // --- INTERCEPTADOR ALGORÍTMICO DE SEGURANÇA ---
            if (MASTER_JIDS.includes(userJid) && accountName === 'main') {
                const autorizarMatch = text.trim().match(/^AUTORIZAR\s+(\d{4})$/i);
                if (autorizarMatch) {
                    const token = autorizarMatch[1];
                    const approvedJid = consumeApprovalToken(token);
                    if (approvedJid) {
                        await addTrustedChat(approvedJid);
                        await sock.sendMessage(MASTER_NUMBER, { text: `✅ Chat autorizado com sucesso! (bypass determinístico)` });
                        await sock.sendMessage(approvedJid, { text: `✅ Boas notícias! O administrador acabou de autorizar este chat.` });
                    } else {
                        await sock.sendMessage(MASTER_NUMBER, { text: `❌ Token inválido ou expirado.` });
                    }
                    continue; // Ignora o resto do pipeline da IA
                }


            }
            // ----------------------------------------------

            // --- GERENCIAMENTO DE GRUPOS IGNORADOS ---
            if (isGroup && MASTER_JIDS.includes(userJid) && accountName === 'main') {
                const cmd = isGroupManagementCommand(text);
                if (cmd.action === 'ignore') {
                    const groupName = await getChatName(sock, chatJid, accountName) || chatJid;
                    addIgnoredGroup(chatJid, groupName);
                    await sock.sendMessage(chatJid, { text: '✅ Entendido! Não vou mais responder neste grupo. Se precisar de mim, é só me chamar no privado. 😊' });
                    continue;
                }
                if (cmd.action === 'unignore') {
                    removeIgnoredGroup(chatJid);
                    await sock.sendMessage(chatJid, { text: '✅ Pronto! Voltei a prestar atenção neste grupo. 😊' });
                    continue;
                }
            }
            // ----------------------------------------------

            // --- PROCESSAMENTO DE COMANDOS DETERMINÍSTICOS (/comando) ---
            if (isCommand(text)) {
                const handled = await handleCommand({
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
                if (handled) {
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
                const displayName = msg.pushName || userJid.split('@')[0];
                
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

            // Ignora as próprias mensagens que o bot/usuário enviou para evitar self-loops
            if (msg.key.fromMe) continue;

            // Ignora TODAS as mensagens enviadas pela própria Bia (main JID / LID) em qualquer socket
            if (isMessageFromBia(userJid)) {
                logger.info(`[IGNORED] Mensagem enviada pela própria Bia (${userJid}) recebida na conta ${accountName}. Descartando.`);
                continue;
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
