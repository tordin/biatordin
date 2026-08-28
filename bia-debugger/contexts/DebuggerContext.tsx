"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Chat, Message, TraceNode } from '../lib/mockData';

export type LogEvent = {
  timestamp: string;
  event: string;
  threadId?: string;
  agentName?: string;
  triggerId?: string;
  triggerType?: string;
  data: any;
};

interface DebuggerContextData {
  chats: Chat[];
  messages: Record<string, Message[]>;
  traces: Record<string, TraceNode[]>;
  inspectors: Record<string, any>;
  connected: boolean;
}

const DebuggerContext = createContext<DebuggerContextData | undefined>(undefined);

export function DebuggerProvider({ children }: { children: React.ReactNode }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [traces, setTraces] = useState<Record<string, TraceNode[]>>({});
  const [inspectors, setInspectors] = useState<Record<string, any>>({});
  const [connected, setConnected] = useState(false);

  // Synchronous in-memory store to prevent stale closure bugs during batch history processing
  const chatsRef = useRef<Chat[]>([]);
  const messagesRef = useRef<Record<string, Message[]>>({});
  const tracesRef = useRef<Record<string, TraceNode[]>>({});
  const inspectorsRef = useRef<Record<string, any>>({});

  useEffect(() => {
    let isMounted = true;
    let eventSource: EventSource | null = null;
    const activeAgents = new Map<string, { name: string, type: string, tint: string, state: any }>();
    // LLM nodes: keyed por runId do LangChain (handleChatModelStart + handleLLMStart
    // disparam 2x para a mesma chamada), com fallback por triggerId para eventos legados.
    const activeLlmIds = new Map<string, string>();
    const llmNodeByRunId = new Map<string, string>();
    // Tool nodes: keyed por runId para que TOOL_END pareie corretamente mesmo com
    // chamadas paralelas de ferramentas.
    const activeToolIds = new Map<string, string>();
    const toolNodeByRunId = new Map<string, string>();
    const triggerChatIds = new Map<string, string>();
    const triggerSilenceReasons = new Map<string, string>();
    // Chat do Master, detectado via contextData.chatJid nos eventos AGENT_START ou JIDs conhecidos.
    let masterChatId: string | null = null;
    const MASTER_JIDS = new Set(['5519997064504@s.whatsapp.net', '233070879867118@lid', 'Luiz']);

    const isMasterIdentifier = (idOrName?: string) => {
      if (!idOrName) return false;
      if (MASTER_JIDS.has(idOrName)) return true;
      if (idOrName.toLowerCase() === 'luiz') return true;
      if (masterChatId && idOrName === masterChatId) return true;
      
      // Strip account prefix (e.g., 'main_', 'personal_') and check again
      const strippedId = idOrName.replace(/^(main|personal)_/, '');
      if (MASTER_JIDS.has(strippedId)) return true;
      
      return false;
    };

    const getCanonicalChatId = (chatId: string, senderName?: string, chatName?: string) => {
      if (!chatId || chatId === 'sistema' || chatId.startsWith('system_') || chatId === 'main_system' || chatId === 'main_new-chat' || chatId.endsWith('_new-chat')) {
        return 'sistema';
      }
      if (isMasterIdentifier(chatId)) {
        return masterChatId || 'Luiz';
      }
      return chatId;
    };

    const isRawJid = (val?: string) => !val || val.includes('@') || /^\d+$/.test(val) || /^(main|personal)_/.test(val);

    // Monotonic counter to avoid duplicate IDs when two events share the same ms timestamp
    let _nodeSeq = 0;
    const uniqueNodeId = (ts: string) => `${ts}-${++_nodeSeq}`;

    const formatInputBrief = (input: any): string => {
      if (!input) return '';
      let parsed = input;
      if (typeof input === 'string') {
        try {
          parsed = JSON.parse(input);
        } catch {
          return input.length > 50 ? input.slice(0, 47) + '...' : input;
        }
      }
      if (typeof parsed === 'object' && parsed !== null) {
        const keys = Object.keys(parsed).filter(k => k !== 'accountName');
        if (keys.length === 0) return '';
        const parts = keys.map(k => {
          const val = typeof parsed[k] === 'string' ? `"${parsed[k]}"` : JSON.stringify(parsed[k]);
          return `${k}: ${val}`;
        });
        const joined = parts.join(', ');
        return joined.length > 60 ? joined.slice(0, 57) + '...' : joined;
      }
      return String(input);
    };

    const extractToolOutput = (raw: any): string => {
      if (raw === undefined || raw === null) return '';
      if (typeof raw === 'string') {
        if (raw.startsWith('{') && (raw.includes('"ToolMessage"') || raw.includes('"kwargs"'))) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed?.kwargs?.content) return extractToolOutput(parsed.kwargs.content);
            if (parsed?.content) return extractToolOutput(parsed.content);
          } catch {}
        }
        return raw;
      }
      if (typeof raw === 'object') {
        if (typeof raw.content === 'string') return raw.content;
        if (raw.kwargs && typeof raw.kwargs.content === 'string') return raw.kwargs.content;
        if (typeof raw.text === 'string') return raw.text;
        try {
          return JSON.stringify(raw, null, 2);
        } catch {
          return String(raw);
        }
      }
      return String(raw);
    };

    const upsertChat = (chatId: string, name: string, ts: string, lastMsgText?: string, accountType?: 'main' | 'personal' | 'system', flush = true) => {
      const prev = chatsRef.current;
      const existingIdx = prev.findIndex(c => c.id === chatId);
      const formattedTime = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      let cleanName = (name || chatId);
      cleanName = cleanName.replace(/ (📱|🤖)$/, '');
      cleanName = cleanName.replace(/^(👑 |⚙️ |🔇 )/, '');

      if (existingIdx >= 0) {
          const currentName = prev[existingIdx].name.replace(/^(👑 |⚙️ |🔇 )/, '');
          if (!isRawJid(currentName) && isRawJid(cleanName)) {
              cleanName = currentName;
          }
      }

      if (isRawJid(cleanName)) {
          cleanName = cleanName.replace(/^(main|personal)_/, '');
          if (cleanName.includes('_')) {
             cleanName = cleanName.split('_').pop() || cleanName;
          }
          cleanName = cleanName.replace(/@s\.whatsapp\.net$/, '');
          cleanName = cleanName.replace(/@g\.us$/, ' (Grupo)');
          cleanName = cleanName.replace(/@lid$/, ' (LID)');
          
          if (/^55\d{10,11}$/.test(cleanName)) {
              const isNine = cleanName.length === 13;
              const ddd = cleanName.slice(2, 4);
              const p1 = cleanName.slice(4, isNine ? 9 : 8);
              const p2 = cleanName.slice(isNine ? 9 : 8);
              cleanName = `+55 ${ddd} ${p1}-${p2}`;
          }
      }

      const isMaster = isMasterIdentifier(chatId);
      const isSystem = cleanName.toLowerCase().includes('sistema') || chatId.toLowerCase().includes('sistema') || accountType === 'system';
      
      let finalAccountType: 'main' | 'personal' | 'system' | 'master' | undefined = accountType;
      if (isMaster) finalAccountType = 'master';
      else if (isSystem) finalAccountType = 'system';

      if (isMaster) cleanName = 'Luiz';

      let prefix = '';
      if (isMaster) {
         prefix = '👑 ';
      } else if (isSystem) {
         prefix = '⚙️ ';
      }

      const finalDisplayName = `${prefix}${cleanName}`.trim();

      if (existingIdx >= 0) {
        const current = prev[existingIdx];
        const updatedMsg = lastMsgText !== undefined ? lastMsgText : current.lastMessage;
        const updatedType = finalAccountType || current.accountType;
        const updated = { ...current, name: finalDisplayName, time: formattedTime, lastMessage: updatedMsg, accountType: updatedType };

        const copy = [...prev];
        copy.splice(existingIdx, 1);
        chatsRef.current = [updated, ...copy];
      } else {
        chatsRef.current = [{
          id: chatId,
          name: finalDisplayName,
          lastMessage: lastMsgText || 'Nova interação...',
          time: formattedTime,
          unread: 0,
          avatar: cleanName.charAt(0).toUpperCase(),
          accountType: finalAccountType
        }, ...prev];
      }

      if (flush) {
        setChats([...chatsRef.current]);
      }
    };
    
    function processLogEvent(log: LogEvent, flush = true) {
      const triggerId = log.triggerId || log.threadId;
      
      // Handle TRIGGER (New Chat/Message)
      if (log.event === 'TRIGGER') {
        const effectiveTriggerId = log.triggerId || log.threadId || ('trigger-' + uniqueNodeId(log.timestamp));
        const accountName = log.data.accountName || (log.data.threadId ? log.data.threadId.split('_')[0] : 'main');
        const baseJid = log.data.chatJid || 'new-chat';
        const rawChatId = `${accountName}_${baseJid}`;
        
        const senderName = log.data.senderName;
        const senderJid = log.data.senderJid;
        const chatNameRaw = log.data.chatName;
        
        const isSenderSystem = senderName?.toUpperCase() === 'SISTEMA';
        const isSenderLuiz = isMasterIdentifier(senderJid) || isMasterIdentifier(senderName);
        
        let rawName = (chatNameRaw && chatNameRaw !== baseJid) ? chatNameRaw : baseJid;
        if (!isSenderLuiz && !isSenderSystem && senderName && rawName === baseJid) {
          rawName = senderName;
        }

        const chatId = getCanonicalChatId(rawChatId, senderName, chatNameRaw);
        triggerChatIds.set(effectiveTriggerId, chatId);

        if (isMasterIdentifier(rawChatId)) {
          if (!masterChatId) masterChatId = chatId;
        }
        
        const rawTriggerType = log.triggerType || log.data?.triggerType;
        const isCron = rawTriggerType === 'cron_routine' || (isSenderSystem && !!log.data?.routineId);
        const isMission = rawTriggerType === 'mission' || log.data?.triggerType === 'mission';
        const triggerType = rawTriggerType || (isCron ? 'cron_routine' : isSenderSystem ? 'system_inject' : 'whatsapp_message');
        const isSystemTrigger = isCron || isMission || isSenderSystem || triggerType !== 'whatsapp_message';

        let cleanMsgText = log.data.routinePrompt || log.data.messageContent || 'Gatilho do sistema';
        cleanMsgText = cleanMsgText.replace(/^\[(Rotina Agendada|Missão Autônoma|Sistema)\]\s*/i, '');

        upsertChat(chatId, rawName, log.timestamp, cleanMsgText, accountName as any, flush);

        const currentMsgs = messagesRef.current[chatId] || [];
        if (!currentMsgs.some(m => m.runId === effectiveTriggerId && (m.sender === 'user' || m.sender === 'system'))) {
          messagesRef.current = {
            ...messagesRef.current,
            [chatId]: [...currentMsgs, {
              id: log.triggerId || Date.now().toString(),
              chatId: chatId,
              text: cleanMsgText,
              sender: isSystemTrigger ? 'system' : 'user',
              runId: effectiveTriggerId,
              time: new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
              triggerType,
              routineId: log.data?.routineId,
              isCron,
              isMission
            }]
          };
          if (flush) setMessages({ ...messagesRef.current });
        }

        const currentTraces = tracesRef.current[effectiveTriggerId] || [];
        tracesRef.current = {
          ...tracesRef.current,
          [effectiveTriggerId]: [...currentTraces, {
            id: (log.triggerId || effectiveTriggerId) + '-trigger',
            type: 'trigger',
            title: `Gatilho: ${log.triggerType || 'Geral'}`,
            subtitle: log.data.messageContent || 'Iniciando processamento...',
            tint: 'green',
            timestamp: log.timestamp
          }]
        };

        inspectorsRef.current = {
          ...inspectorsRef.current,
          [(log.triggerId || effectiveTriggerId) + '-trigger']: {
            context: 'Gatilho Inicial da Conversa',
            memory: 'N/A',
            agentState: log.data,
            modelOutput: {},
            logs: `Payload recebido via ${log.triggerType || 'evento externo'}`
          }
        };

        if (flush) {
          setTraces({ ...tracesRef.current });
          setInspectors({ ...inspectorsRef.current });
        }
      }

      // Handle AGENT_START
      if (log.event === 'AGENT_START') {
        if (!triggerId) return;
        const ctxData = log.data?.contextData;
        if (ctxData?.chatJid && isMasterIdentifier(ctxData.chatJid)) {
          const canonical = getCanonicalChatId(ctxData.chatJid);
          if (!masterChatId) masterChatId = canonical;
        }
        const isSupervisor = log.agentName === 'supervisor';
        const isEvaluator = log.agentName === 'evaluator' || log.agentName === 'critic' || log.agentName === 'evaluatorNode';
        activeAgents.set(triggerId, {
          name: isEvaluator ? 'evaluator' : (log.agentName || 'Agent'),
          type: isSupervisor ? 'supervisor' : isEvaluator ? 'evaluator' : 'agent',
          tint: isSupervisor ? 'purple' : isEvaluator ? 'cyan' : 'orange',
          state: log.data
        });
      }

      // Handle AGENT_DECISION
      if (log.event === 'AGENT_DECISION') {
        if (!triggerId) return;
        if (log.data?.reason) {
          triggerSilenceReasons.set(triggerId, log.data.reason);
          let changed = false;
          const nextMsgsState: Record<string, Message[]> = {};
          for (const [cId, msgs] of Object.entries(messagesRef.current)) {
            nextMsgsState[cId] = msgs.map(m => {
              if (m.runId === triggerId && m.isSilent && !m.silenceReason) {
                changed = true;
                return { ...m, silenceReason: log.data.reason };
              }
              return m;
            });
          }
          if (changed) {
            messagesRef.current = nextMsgsState;
            if (flush) setMessages({ ...messagesRef.current });
          }
        }

        const llmNodeId = activeLlmIds.get(triggerId);
        if (llmNodeId) {
          const agentInfo = activeAgents.get(triggerId);
          const isEvaluator = agentInfo?.name === 'evaluator' || agentInfo?.type === 'evaluator';

          const current = [...(tracesRef.current[triggerId] || [])];
          const nodeIdx = current.findIndex(n => n.id === llmNodeId);
          if (nodeIdx >= 0) {
            const decisionText = isEvaluator
              ? `Veredito -> ${log.data.verdict === 'PASS' ? 'PASS (Aprovado)' : log.data.verdict || log.data.nextAgent || 'Concluído'}`
              : `Decisão -> ${log.data.nextAgent || 'Concluído'}`;
            current[nodeIdx] = { ...current[nodeIdx], subtitle: decisionText };
            tracesRef.current = { ...tracesRef.current, [triggerId]: current };
            if (flush) setTraces({ ...tracesRef.current });
          }

          const existingInspector = inspectorsRef.current[llmNodeId];
          if (existingInspector) {
            inspectorsRef.current = {
              ...inspectorsRef.current,
              [llmNodeId]: {
                ...existingInspector,
                modelOutput: log.data, 
                logs: (existingInspector.logs || '') + `\n[INFO] ${isEvaluator ? 'Veredito' : 'Decisão'} processado(a).`
              }
            };
            if (flush) setInspectors({ ...inspectorsRef.current });
          }
        }
      }

      // Handle LLM_START
      if (log.event === 'LLM_START') {
        if (!triggerId) return;
        const runId = log.data?.runId;
        const agentInfo = activeAgents.get(triggerId) || { name: 'Agent', type: 'agent', tint: 'orange', state: {} };
        
        const rawAgentName = log.agentName || agentInfo.name;
        const isEvaluator = rawAgentName === 'evaluator' || rawAgentName === 'critic' || rawAgentName === 'evaluatorNode';
        const isSupervisor = !isEvaluator && (rawAgentName === 'supervisor' || agentInfo.type === 'supervisor');
        const agentDisplayName = (rawAgentName === 'graph' && agentInfo.name && agentInfo.name !== 'Agent')
          ? agentInfo.name
          : rawAgentName;

        const llmTitle = isSupervisor 
          ? 'Supervisora (Decisão)' 
          : isEvaluator
          ? 'Avaliador de Qualidade (Critic)'
          : `${agentDisplayName || 'Agente'} (Raciocínio)`;

        const llmSubtitle = isSupervisor
          ? 'Decisão (LLM)'
          : isEvaluator
          ? 'Auditoria & Controle de Qualidade'
          : 'Raciocínio do Especialista';

        const nodeType = isSupervisor ? 'supervisor' : isEvaluator ? 'evaluator' : (agentInfo.type as any);
        const nodeTint = isSupervisor ? 'purple' : isEvaluator ? 'cyan' : (agentInfo.tint as any);

        // 1. Checagem por runId exato
        let targetLlmNodeId = runId ? llmNodeByRunId.get(runId) : undefined;

        // 2. Se não encontrou por runId, verifica se a última etapa LLM ativa deste trigger ainda está aguardando saída
        if (!targetLlmNodeId) {
          const activeId = activeLlmIds.get(triggerId);
          if (activeId) {
            const activeInspector = inspectorsRef.current[activeId];
            const isWaitingOutput = !activeInspector || !activeInspector.modelOutput || Object.keys(activeInspector.modelOutput).length === 0;
            if (isWaitingOutput) {
              targetLlmNodeId = activeId;
            }
          }
        }

        if (targetLlmNodeId) {
          // Reaproveita o nó LLM ativo existente (evita nó duplicado sem saída)
          if (runId) llmNodeByRunId.set(runId, targetLlmNodeId);

          const current = [...(tracesRef.current[triggerId] || [])];
          const idx = current.findIndex(n => n.id === targetLlmNodeId);
          if (idx >= 0) {
            current[idx] = {
              ...current[idx],
              type: nodeType,
              title: llmTitle,
              subtitle: current[idx].subtitle || llmSubtitle,
              agentName: isEvaluator ? 'evaluator' : agentDisplayName,
              tint: nodeTint
            };
            tracesRef.current = { ...tracesRef.current, [triggerId]: current };
            if (flush) setTraces({ ...tracesRef.current });
          }

          const existingInspector = inspectorsRef.current[targetLlmNodeId] || {};
          const updated: any = { ...existingInspector };
          if (log.data.messages && Array.isArray(log.data.messages)) updated.llmMessages = log.data.messages;
          if (log.data.prompts && Array.isArray(log.data.prompts) && !updated.context) updated.context = log.data.prompts.join('\n');
          inspectorsRef.current = { ...inspectorsRef.current, [targetLlmNodeId]: updated };
          if (flush) setInspectors({ ...inspectorsRef.current });
          return;
        }

        // Se for uma nova chamada legítima (após o término da anterior)
        const llmNodeId = uniqueNodeId(log.timestamp);
        if (runId) llmNodeByRunId.set(runId, llmNodeId);
        activeLlmIds.set(triggerId, llmNodeId);

        const current = tracesRef.current[triggerId] || [];
        tracesRef.current = {
          ...tracesRef.current,
          [triggerId]: [...current, {
            id: llmNodeId,
            type: nodeType,
            title: llmTitle,
            subtitle: llmSubtitle,
            agentName: isEvaluator ? 'evaluator' : agentDisplayName,
            tint: nodeTint,
            isLlmStep: true,
            timestamp: log.timestamp
          }]
        };

        let systemPrompt = '';
        let memory = '';
        if (log.data.messages && Array.isArray(log.data.messages)) {
          const sysMsg = log.data.messages.find((m: any) => m.role === 'SYSTEM');
          if (sysMsg) {
            systemPrompt = sysMsg.content;
            const memoryMatch = systemPrompt.match(/<core_memory>([\s\S]*?)<\/core_memory>/);
            if (memoryMatch) {
               memory = memoryMatch[1].trim();
               systemPrompt = systemPrompt.replace(/<core_memory>[\s\S]*?<\/core_memory>/, '').trim();
            }
          }

          // Retroactive backfill: se houver nós de ferramentas anteriores ainda em "Executando...",
          // preenche com o conteúdo real das mensagens 'TOOL' registradas neste LLM_START.
          if (triggerId) {
            const toolMsgs = log.data.messages.filter((m: any) => m.role === 'TOOL' && m.content);
            if (toolMsgs.length > 0) {
              const traceList = tracesRef.current[triggerId] || [];
              const pendingToolNodes = traceList.filter(n => n.isToolStep && (!n.toolDetails?.rawOutput || n.toolDetails.rawOutput === 'Executando...'));
              if (pendingToolNodes.length > 0) {
                const startOffset = Math.max(0, toolMsgs.length - pendingToolNodes.length);
                pendingToolNodes.forEach((node, i) => {
                  const matchedMsg = toolMsgs[startOffset + i];
                  if (matchedMsg) {
                    const outText = typeof matchedMsg.content === 'string' ? matchedMsg.content : JSON.stringify(matchedMsg.content);
                    node.toolDetails = {
                      ...node.toolDetails,
                      name: node.toolDetails?.name || node.title,
                      input: node.toolDetails?.input || '',
                      rawOutput: outText
                    };
                    if (inspectorsRef.current[node.id]) {
                      inspectorsRef.current[node.id].toolDetails = { ...node.toolDetails };
                    }
                  }
                });
              }
            }
          }
        }
        
        inspectorsRef.current = {
          ...inspectorsRef.current,
          [llmNodeId]: {
            context: systemPrompt || 'N/A',
            memory: memory || 'N/A',
            agentState: agentInfo.state,
            llmMessages: log.data.messages || [],
            modelOutput: {},
            logs: `[INFO] LLM_START iniciado.`
          }
        };

        if (flush) {
          setTraces({ ...tracesRef.current });
          setInspectors({ ...inspectorsRef.current });
        }
      }

      // Handle LLM_END
      if (log.event === 'LLM_END') {
        if (!triggerId) return;
        const runId = log.data?.runId;
        const llmNodeId = runId ? llmNodeByRunId.get(runId) : activeLlmIds.get(triggerId);
        if (llmNodeId) {
          const current = [...(tracesRef.current[triggerId] || [])];
          const nodeIdx = current.findIndex(n => n.id === llmNodeId);
          if (nodeIdx >= 0) {
            // Only update subtitle if not already customized by decision
            if (!current[nodeIdx].subtitle || current[nodeIdx].subtitle.includes('Raciocínio') || current[nodeIdx].subtitle.includes('Decisão (LLM)')) {
              current[nodeIdx] = { ...current[nodeIdx], subtitle: 'Resposta / Plano gerado' };
            }
            tracesRef.current = { ...tracesRef.current, [triggerId]: current };
            if (flush) setTraces({ ...tracesRef.current });
          }

          const existingInspector = inspectorsRef.current[llmNodeId];
          if (existingInspector) {
            inspectorsRef.current = {
              ...inspectorsRef.current,
              [llmNodeId]: {
                ...existingInspector,
                modelOutput: log.data.generations || existingInspector.modelOutput,
              }
            };
            if (flush) setInspectors({ ...inspectorsRef.current });
          }
        }
      }

      // Handle TOOL_START
      if (log.event === 'TOOL_START') {
        if (!triggerId) return;
        const toolNodeId = uniqueNodeId(log.timestamp);
        const toolRunId = log.data?.runId;
        if (toolRunId) toolNodeByRunId.set(toolRunId, toolNodeId);
        activeToolIds.set(triggerId, toolNodeId);

        const agentInfo = activeAgents.get(triggerId) || { name: 'Agent', type: 'agent', tint: 'orange', state: {} };
        const briefInput = formatInputBrief(log.data.input);
        const toolSubtitle = briefInput 
          ? `${agentInfo.name} • ${briefInput}` 
          : `${agentInfo.name} • Executando ferramenta`;
        
        const current = tracesRef.current[triggerId] || [];
        tracesRef.current = {
          ...tracesRef.current,
          [triggerId]: [...current, {
            id: toolNodeId,
            type: 'tool' as any,
            title: log.data.toolName,
            subtitle: toolSubtitle,
            agentName: agentInfo.name,
            tint: agentInfo.tint as any,
            isToolStep: true,
            toolDetails: {
              name: log.data.toolName,
              input: typeof log.data.input === 'string' ? log.data.input : JSON.stringify(log.data.input),
              rawOutput: 'Executando...'
            },
            timestamp: log.timestamp
          }]
        };

        inspectorsRef.current = {
          ...inspectorsRef.current,
          [toolNodeId]: {
            context: 'N/A',
            memory: 'N/A',
            agentState: agentInfo.state,
            modelOutput: {},
            logs: `[INFO] Iniciando ferramenta ${log.data.toolName}`,
            toolDetails: {
              name: log.data.toolName,
              input: typeof log.data.input === 'string' ? log.data.input : JSON.stringify(log.data.input),
              rawOutput: 'Executando...'
            }
          }
        };

        if (flush) {
          setTraces({ ...tracesRef.current });
          setInspectors({ ...inspectorsRef.current });
        }
      }

      // Handle TOOL_END
      if (log.event === 'TOOL_END') {
        const toolRunId = log.data?.runId;
        let toolNodeId = toolRunId ? toolNodeByRunId.get(toolRunId) : undefined;
        let resolvedTriggerId = triggerId;

        if (!resolvedTriggerId && toolNodeId) {
          for (const [trigId, traceList] of Object.entries(tracesRef.current)) {
            if (traceList.some(n => n.id === toolNodeId)) {
              resolvedTriggerId = trigId;
              break;
            }
          }
        }

        if (!toolNodeId && resolvedTriggerId) {
          toolNodeId = activeToolIds.get(resolvedTriggerId);
        }

        if (resolvedTriggerId && toolNodeId) {
          const outputStr = extractToolOutput(log.data?.output);
          const isError = log.data?.isError === true || outputStr.startsWith('Error:');

          const current = [...(tracesRef.current[resolvedTriggerId] || [])];
          const nodeIdx = current.findIndex(n => n.id === toolNodeId);
          if (nodeIdx >= 0) {
            const node = current[nodeIdx];
            current[nodeIdx] = {
              ...node,
              tint: isError ? 'red' : node.tint,
              isErrorStep: isError ? true : node.isErrorStep,
              toolDetails: node.toolDetails ? { ...node.toolDetails, rawOutput: outputStr } : {
                name: node.title,
                input: '',
                rawOutput: outputStr
              }
            };
            tracesRef.current = { ...tracesRef.current, [resolvedTriggerId]: current };
            if (flush) setTraces({ ...tracesRef.current });
          }

          const existing = inspectorsRef.current[toolNodeId];
          if (existing) {
            inspectorsRef.current = {
              ...inspectorsRef.current,
              [toolNodeId]: {
                ...existing,
                logs: existing.logs + (isError ? `\n[ERROR] Falha na ferramenta: ${outputStr}` : '\n[INFO] Ferramenta concluída.'),
                toolDetails: existing.toolDetails ? { ...existing.toolDetails, rawOutput: outputStr } : {
                  name: existing.toolDetails?.name || 'tool',
                  input: existing.toolDetails?.input || '',
                  rawOutput: outputStr
                }
              }
            };
            if (flush) setInspectors({ ...inspectorsRef.current });
          }
        }
      }

      // Handle ERROR
      if (log.event === 'ERROR') {
        if (!triggerId) return; // Do not pollute conversation traces with orphan global errors
        const errorMsg = log.data?.message || 'Erro durante a execução';
        const errorArgs = log.data?.args ? (Array.isArray(log.data.args) ? log.data.args.join(' ') : String(log.data.args)) : '';
        const fullErr = errorArgs ? `${errorMsg}: ${errorArgs}` : errorMsg;
        const errorNodeId = uniqueNodeId(log.timestamp);
        
        const current = tracesRef.current[triggerId] || [];
        tracesRef.current = {
          ...tracesRef.current,
          [triggerId]: [...current, {
            id: errorNodeId,
            type: 'error' as any,
            title: 'Alerta / Erro de Execução',
            subtitle: fullErr,
            tint: 'red' as any,
            isErrorStep: true,
            timestamp: log.timestamp
          }]
        };

        inspectorsRef.current = {
          ...inspectorsRef.current,
          [errorNodeId]: {
            context: 'Falha ou Limite de Execução Detectado',
            memory: 'N/A',
            agentState: log.data,
            modelOutput: {},
            logs: `[ERROR] ${fullErr}`
          }
        };

        if (flush) {
          setTraces({ ...tracesRef.current });
          setInspectors({ ...inspectorsRef.current });
        }
      }

      // Handle TRIGGER_END
      if (log.event === 'TRIGGER_END') {
        if (!triggerId) return;
        const accountName = log.data.accountName || (log.data.threadId ? log.data.threadId.split('_')[0] : 'main');
        const baseJid = log.data.chatJid || 'new-chat';
        const rawChatId = `${accountName}_${baseJid}`;
        const chatId = triggerChatIds.get(triggerId) || getCanonicalChatId(rawChatId, log.data.senderName, log.data.chatName);
        const isError = log.data.status === 'error' || !!log.data.error;
        const isSilent = !log.data.responseText && !isError;
        const text = log.data.responseText || (isError ? '[Erro na Execução]' : 'Silêncio');
        const silenceReason = isSilent ? (log.data.reason || (triggerId ? triggerSilenceReasons.get(triggerId) : undefined)) : undefined;

        const currentMsgs = messagesRef.current[chatId] || [];
        
        if (!isSilent && !isError) {
            // The actual text message is handled by OUTBOUND_MESSAGE
            return;
        }
        
        if (isSilent) {
            const sentAnywhere = Object.values(messagesRef.current).some(msgs => msgs.some(m => m.runId === triggerId && !m.isSilent && !m.isError && m.sender === 'bia'));
            if (sentAnywhere) {
                return;
            }
        }

        messagesRef.current = {
          ...messagesRef.current,
          [chatId]: [...currentMsgs, {
            id: (log.triggerId || triggerId) + '-end',
            chatId: chatId,
            text: text,
            sender: 'bia',
            runId: triggerId,
            time: new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
            isSilent,
            isError,
            silenceReason
          }]
        };

        if (flush) {
          setMessages({ ...messagesRef.current });
        }
      }

      // Handle OUTBOUND_MESSAGE
      if (log.event === 'OUTBOUND_MESSAGE') {
        const isStandalone = !triggerId;
        const effectiveTriggerId = triggerId || ('DIR_' + (log.timestamp ? new Date(log.timestamp).getTime().toString(16).slice(-6).toUpperCase() : Math.random().toString(16).slice(2, 8).toUpperCase()));
        let accountName = log.threadId ? log.threadId.split('_')[0] : 'main';
        const triggerChatId = log.triggerId ? triggerChatIds.get(log.triggerId) : undefined;
        
        if (!['main', 'personal', 'system'].includes(accountName)) {
          if (triggerChatId) {
            if (triggerChatId.startsWith('personal_')) accountName = 'personal';
            else if (triggerChatId.startsWith('main_')) accountName = 'main';
            else if (triggerChatId.startsWith('system_')) accountName = 'system';
            else accountName = 'main';
          } else {
            accountName = 'main';
          }
        }
        
        const baseJid = log.data.chatJid || 'new-chat';
        const rawChatId = `${accountName}_${baseJid}`;
        
        if (rawChatId) {
          const chatId = triggerChatId || getCanonicalChatId(rawChatId);
          upsertChat(chatId, rawChatId, log.timestamp, log.data.text, accountName as any, flush);
          
          const currentMsgs = messagesRef.current[chatId] || [];
          if (!currentMsgs.some(m => m.runId === effectiveTriggerId && m.text === log.data.text && m.sender === 'bia')) {
            messagesRef.current = {
              ...messagesRef.current,
              [chatId]: [...currentMsgs, {
                id: uniqueNodeId(log.timestamp) + '-outbound',
                chatId: chatId,
                text: log.data.text || '',
                sender: 'bia',
                runId: effectiveTriggerId,
                time: new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                isSilent: false,
                isError: false
              }]
            };
            if (flush) setMessages({ ...messagesRef.current });
          }

          const outboundNodeId = uniqueNodeId(log.timestamp) + '-trace-outbound';
          const textSnippet = log.data.text 
            ? ` • "${log.data.text.slice(0, 45).replace(/\n/g, ' ')}${log.data.text.length > 45 ? '...' : ''}"` 
            : '';

          const current = tracesRef.current[effectiveTriggerId] || [];
          const newTraceNodes = [...current];

          if (isStandalone && newTraceNodes.length === 0) {
            const triggerNodeId = `${effectiveTriggerId}-trigger`;
            newTraceNodes.push({
              id: triggerNodeId,
              type: 'trigger',
              title: 'Gatilho: Notificação Direta',
              subtitle: 'Disparo direto de mensagem',
              tint: 'green',
              timestamp: log.timestamp
            });
            inspectorsRef.current = {
              ...inspectorsRef.current,
              [triggerNodeId]: {
                context: 'Notificação Direta',
                memory: 'N/A',
                agentState: log.data,
                modelOutput: {},
                logs: `Disparo direto emitido em ${log.timestamp}`
              }
            };
          }

          newTraceNodes.push({
            id: outboundNodeId,
            type: 'output',
            title: 'Envio de Mensagem',
            subtitle: `Para: ${chatId.split('@')[0]}${textSnippet}`,
            tint: 'green',
            timestamp: log.timestamp
          });

          tracesRef.current = {
            ...tracesRef.current,
            [effectiveTriggerId]: newTraceNodes
          };

          inspectorsRef.current = {
            ...inspectorsRef.current,
            [outboundNodeId]: {
              context: 'Mensagem enviada ao usuário/destinatário',
              memory: 'N/A',
              outboundText: log.data.text || '',
              recipient: chatId,
              accountName: accountName,
              agentState: log.data,
              modelOutput: {},
              logs: `[INFO] Mensagem enviada com sucesso para ${chatId} (${baseJid})`
            }
          };

          if (flush) {
            setTraces({ ...tracesRef.current });
            setInspectors({ ...inspectorsRef.current });
          }
        }
      }

      // Handle DB Logs
      if (log.event === 'DB_QUERY') {
         // console.log("DB_QUERY", log.data);
      }
    }

    fetch('http://localhost:3001/api/history')
      .then(r => r.json())
      .then(data => {
        if (!isMounted) return;
        if (data.events && Array.isArray(data.events)) {
          data.events.forEach((evt: any) => {
            if (evt) processLogEvent(evt as LogEvent, false);
          });

          // Single batch commit to React state after processing all historical events
          setChats([...chatsRef.current]);
          setMessages({ ...messagesRef.current });
          setTraces({ ...tracesRef.current });
          setInspectors({ ...inspectorsRef.current });
        }
        
        // Connect to SSE only after history is processed
        eventSource = new EventSource('http://localhost:3001/api/stream');
        eventSource.onopen = () => setConnected(true);
        eventSource.onerror = () => setConnected(false);
        
        eventSource.onmessage = (e) => {
          try {
            const rawLog = JSON.parse(e.data);
            if (rawLog.type === 'CONNECTED') return;
            processLogEvent(rawLog as LogEvent, true);
          } catch (err) {
            console.error('Error parsing SSE event', err);
          }
        };
      })
      .catch(err => {
        console.error('Failed to load history', err);
      });

    return () => {
      isMounted = false;
      if (eventSource) {
        eventSource.close();
      }
    };
  }, []);

  return (
    <DebuggerContext.Provider value={{ chats, messages, traces, inspectors, connected }}>
      {children}
    </DebuggerContext.Provider>
  );
}

export function useDebugger() {
  const ctx = useContext(DebuggerContext);
  if (!ctx) throw new Error('useDebugger must be used within DebuggerProvider');
  return ctx;
}
