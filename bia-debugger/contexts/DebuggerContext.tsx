"use client";

import React, { createContext, useContext, useEffect, useState } from 'react';
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
  // Start with mock data for visuals, but we will prepend real data
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [traces, setTraces] = useState<Record<string, TraceNode[]>>({});
  const [inspectors, setInspectors] = useState<Record<string, any>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let isMounted = true;
    let eventSource: EventSource | null = null;
    const activeAgents = new Map<string, { name: string, type: string, tint: string, state: any }>();
    // LLM nodes: keyed por runId do LangChain (handleChatModelStart + handleLLMStart
    // disparam 2x para a mesma chamada), com fallback por triggerId para eventos legados.
    const activeLlmIds = new Map<string, string>();
    const llmNodeByRunId = new Map<string, string>();
    // Tool nodes: keyed por runId para que TOOL_END pareie corretamente mesmo com
    // chamadas paralelas de ferramentas (antes, um slot por triggerId misturava os nós).
    const activeToolIds = new Map<string, string>();
    const toolNodeByRunId = new Map<string, string>();
    const triggerChatIds = new Map<string, string>();
    // Chat do Master, detectado via contextData.isTrustedChat nos eventos AGENT_START ou JIDs conhecidos.
    // Usado para rotear mensagens de notify_master para a conversa correta.
    let masterChatId: string | null = null;
    const MASTER_JIDS = new Set(['5519997064504@s.whatsapp.net', '233070879867118@lid', 'Luiz']);

    const isMasterIdentifier = (idOrName?: string) => {
      if (!idOrName) return false;
      if (MASTER_JIDS.has(idOrName)) return true;
      if (idOrName.toLowerCase() === 'luiz') return true;
      if (masterChatId && idOrName === masterChatId) return true;
      return false;
    };

    const getCanonicalChatId = (chatId: string, senderName?: string, chatName?: string) => {
      if (isMasterIdentifier(chatId) || isMasterIdentifier(senderName) || isMasterIdentifier(chatName)) {
        return masterChatId || 'Luiz';
      }
      return chatId;
    };

    const isRawJid = (val?: string) => !val || val.includes('@') || /^\d+$/.test(val);

    // Monotonic counter to avoid duplicate IDs when two events share the same ms timestamp
    let _nodeSeq = 0;
    const uniqueNodeId = (ts: string) => `${ts}-${++_nodeSeq}`;

    // Garante que um chatId exista na lista de conversas. Necessário quando a Bia
    // envia a primeira mensagem a um alvo/contato que ainda não tem conversa no sidebar
    // (ex: start_mission/send_message_to_target para um número novo).
    const upsertChat = (chatId: string, name: string, ts: string, lastMsgText?: string) => {
      setChats(prev => {
        const existingIdx = prev.findIndex(c => c.id === chatId);
        const formattedTime = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const isMaster = isMasterIdentifier(chatId) || isMasterIdentifier(name);
        const finalDisplayName = isMaster ? 'Luiz' : (name || chatId);

        if (existingIdx >= 0) {
          const current = prev[existingIdx];
          const updatedName = (isRawJid(current.name) && !isRawJid(finalDisplayName)) ? finalDisplayName : current.name;
          const updatedMsg = lastMsgText !== undefined ? lastMsgText : current.lastMessage;
          const updated = { ...current, name: updatedName, time: formattedTime, lastMessage: updatedMsg };

          const copy = [...prev];
          copy.splice(existingIdx, 1);
          return [updated, ...copy];
        }

        return [{
          id: chatId,
          name: finalDisplayName,
          lastMessage: lastMsgText || 'Nova interação...',
          time: formattedTime,
          unread: 0,
          avatar: finalDisplayName.charAt(0).toUpperCase()
        }, ...prev];
      });
    };
    
    function processLogEvent(log: LogEvent) {
      const triggerId = log.triggerId || log.threadId || 'unknown-run';
      
      // Handle TRIGGER (New Chat/Message)
        if (log.event === 'TRIGGER') {
          const rawChatId = log.data.chatJid || log.data.threadId || 'new-chat';
          const senderName = log.data.senderName;
          const chatNameRaw = log.data.chatName;
          const chatId = getCanonicalChatId(rawChatId, senderName, chatNameRaw);
          triggerChatIds.set(triggerId, chatId);

          if (isMasterIdentifier(rawChatId) || isMasterIdentifier(senderName) || isMasterIdentifier(chatNameRaw)) {
            if (!masterChatId) masterChatId = chatId;
          }

          const finalName = (chatNameRaw && chatNameRaw !== rawChatId) ? chatNameRaw : (senderName || chatId);
          const msgContent = log.data.messageContent || 'Gatilho do sistema';

          upsertChat(chatId, finalName, log.timestamp, msgContent);

          setMessages(prev => {
            const currentMsgs = prev[chatId] || [];
            if (currentMsgs.some(m => m.runId === triggerId && m.sender === 'user')) {
              return prev;
            }
            return {
              ...prev,
              [chatId]: [...currentMsgs, {
                id: log.triggerId || Date.now().toString(),
                chatId: chatId,
                text: msgContent,
                sender: 'user',
                runId: triggerId,
                time: new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
              }]
            };
          });

          setTraces(prev => {
            const current = prev[triggerId] || [];
            return {
              ...prev,
              [triggerId]: [...current, {
                id: log.triggerId + '-trigger',
                type: 'trigger',
                title: `Gatilho: ${log.triggerType || 'Geral'}`,
                subtitle: log.data.messageContent || 'Iniciando processamento...',
                tint: 'green',
                timestamp: log.timestamp
              }]
            };
          });

          setInspectors(prev => ({
            ...prev,
            [log.triggerId + '-trigger']: {
              context: 'Gatilho Inicial da Conversa',
              memory: 'N/A',
              agentState: log.data,
              modelOutput: {},
              logs: `Payload recebido via ${log.triggerType || 'evento externo'}`
            }
          }));
        }

        // Handle AGENT_START
        if (log.event === 'AGENT_START') {
          const ctxData = log.data?.contextData;
          if (ctxData?.isTrustedChat === true && ctxData?.chatJid) {
            const canonical = getCanonicalChatId(ctxData.chatJid);
            if (!masterChatId) masterChatId = canonical;
          }
          activeAgents.set(triggerId, {
            name: log.agentName || 'Agent',
            type: log.agentName === 'supervisor' ? 'supervisor' : 'agent',
            tint: log.agentName === 'supervisor' ? 'purple' : 'orange',
            state: log.data
          });
        }

        // Handle AGENT_DECISION
        if (log.event === 'AGENT_DECISION') {
          const llmNodeId = activeLlmIds.get(triggerId);
          if (llmNodeId) {
            setTraces(prev => {
              const current = [...(prev[triggerId] || [])];
              const nodeIdx = current.findIndex(n => n.id === llmNodeId);
              if (nodeIdx >= 0) {
                current[nodeIdx] = { ...current[nodeIdx], subtitle: `Decisão -> ${log.data.nextAgent || 'Concluído'}` };
              }
              return { ...prev, [triggerId]: current };
            });

            setInspectors(prev => {
               const existing = prev[llmNodeId];
               if (!existing) return prev;
               return {
                 ...prev,
                 [llmNodeId]: {
                   ...existing,
                   modelOutput: log.data, 
                   logs: (existing.logs || '') + `\n[INFO] Decisão processada.`
                 }
               };
            });
          }
        }

        // Handle LLM_START
        // LangChain dispara handleChatModelStart E handleLLMStart para a mesma chamada,
        // produzindo dois eventos com o mesmo runId. Deduplicamos pelo runId; para
        // eventos legados (sem runId) mantemos a checagem por timestamp.
        if (log.event === 'LLM_START') {
          const runId = log.data?.runId;
          const existingLlmByRunId = runId ? llmNodeByRunId.get(runId) : undefined;
          if (existingLlmByRunId) {
            // Evento gêmeo: mescla dados complementares no inspector em vez de criar
            // um segundo nó no trace (messages do chat-model + prompts do LLM).
            setInspectors(prev => {
              const existing = prev[existingLlmByRunId];
              if (!existing) return prev;
              const updated: any = { ...existing };
              if (log.data.messages && Array.isArray(log.data.messages)) updated.llmMessages = log.data.messages;
              if (log.data.prompts && Array.isArray(log.data.prompts) && !updated.context) updated.context = log.data.prompts.join('\n');
              return { ...prev, [existingLlmByRunId]: updated };
            });
            return;
          }
          const existingLlmId = activeLlmIds.get(triggerId);
          if (!runId && existingLlmId && existingLlmId.startsWith(log.timestamp)) {
            // Duplicate event (legado, sem runId) — skip
            return;
          }
          const llmNodeId = uniqueNodeId(log.timestamp);
          if (runId) llmNodeByRunId.set(runId, llmNodeId);
          activeLlmIds.set(triggerId, llmNodeId);
          
          const agentInfo = activeAgents.get(triggerId) || { name: 'Agent', type: 'agent', tint: 'orange', state: {} };
          
          setTraces(prev => {
            const current = prev[triggerId] || [];
            return {
              ...prev,
              [triggerId]: [...current, {
                id: llmNodeId,
                type: agentInfo.type as any,
                title: agentInfo.name,
                subtitle: `Avaliação (LLM)`,
                tint: agentInfo.tint as any,
                isLlmStep: true,
                timestamp: log.timestamp
              }]
            };
          });

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
          }
          
          setInspectors(prev => ({
             ...prev,
             [llmNodeId]: {
               context: systemPrompt || 'N/A',
               memory: memory || 'N/A',
               agentState: agentInfo.state,
               llmMessages: log.data.messages || [],
               modelOutput: {},
               logs: `[INFO] LLM_START iniciado.`
             }
          }));
        }

        // Handle LLM_END
        if (log.event === 'LLM_END') {
          const runId = log.data?.runId;
          const llmNodeId = runId ? llmNodeByRunId.get(runId) : activeLlmIds.get(triggerId);
          if (llmNodeId) {
            setTraces(prev => {
              const current = [...(prev[triggerId] || [])];
              const nodeIdx = current.findIndex(n => n.id === llmNodeId);
              if (nodeIdx >= 0) {
                current[nodeIdx] = { ...current[nodeIdx], subtitle: 'Resposta recebida' };
              }
              return { ...prev, [triggerId]: current };
            });

            setInspectors(prev => {
               const existing = prev[llmNodeId];
               if (!existing) return prev;
               return {
                 ...prev,
                 [llmNodeId]: {
                   ...existing,
                   modelOutput: log.data.generations || existing.modelOutput,
                 }
               };
            });
          }
        }

        // Handle TOOL_START
        if (log.event === 'TOOL_START') {
          const toolNodeId = uniqueNodeId(log.timestamp);
          const toolRunId = log.data?.runId;
          if (toolRunId) toolNodeByRunId.set(toolRunId, toolNodeId);
          activeToolIds.set(triggerId, toolNodeId);


          const agentInfo = activeAgents.get(triggerId) || { name: 'Agent', type: 'agent', tint: 'orange', state: {} };
          
          setTraces(prev => {
            const current = prev[triggerId] || [];
            return {
              ...prev,
              [triggerId]: [...current, {
                id: toolNodeId,
                type: agentInfo.type as any,
                title: agentInfo.name,
                subtitle: `Ferramenta: ${log.data.toolName}`,
                tint: agentInfo.tint as any,
                isToolStep: true,
                toolDetails: {
                  name: log.data.toolName,
                  input: log.data.input,
                  rawOutput: 'Executando...'
                },
                timestamp: log.timestamp
              }]
            };
          });

          setInspectors(prev => ({
            ...prev,
            [toolNodeId]: {
              context: 'N/A',
              memory: 'N/A',
              agentState: agentInfo.state,
              modelOutput: {},
              logs: `[INFO] Iniciando ferramenta ${log.data.toolName}`,
              toolDetails: {
                name: log.data.toolName,
                input: log.data.input,
                rawOutput: 'Executando...'
              }
            }
          }));
        }

        // Handle TOOL_END
        if (log.event === 'TOOL_END') {
          const toolRunId = log.data?.runId;
          const toolNodeId = toolRunId ? toolNodeByRunId.get(toolRunId) : activeToolIds.get(triggerId);
          if (toolNodeId) {
            setTraces(prev => {
              const current = [...(prev[triggerId] || [])];
              const nodeIdx = current.findIndex(n => n.id === toolNodeId);
              if (nodeIdx >= 0) {
                const node = current[nodeIdx];
                current[nodeIdx] = {
                  ...node,
                  subtitle: 'Concluído',
                  toolDetails: node.toolDetails ? { ...node.toolDetails, rawOutput: log.data.output } : undefined
                };
              }
              return { ...prev, [triggerId]: current };
            });

            setInspectors(prev => {
              const existing = prev[toolNodeId];
              if (!existing) return prev;
              return {
                ...prev,
                [toolNodeId]: {
                  ...existing,
                  logs: existing.logs + '\n[INFO] Ferramenta concluída.',
                  toolDetails: existing.toolDetails ? { ...existing.toolDetails, rawOutput: log.data.output } : undefined
                }
              };
            });
          }
        }

        // Handle TRIGGER_END
        if (log.event === 'TRIGGER_END') {
          const rawChatId = log.data.chatJid || log.data.threadId || 'new-chat';
          const chatId = triggerChatIds.get(triggerId) || getCanonicalChatId(rawChatId, log.data.senderName, log.data.chatName);
          const isError = log.data.status === 'error' || !!log.data.error;
          const isSilent = !log.data.responseText && !isError;
          const text = log.data.responseText || (isError ? '[Erro na Execução]' : 'Silêncio');

          setMessages(prev => {
            const currentMsgs = prev[chatId] || [];
            
            if (!isSilent && !isError) {
                // Ignore. The actual text message is handled by OUTBOUND_MESSAGE
                return prev;
            }
            
            if (isSilent) {
                const sentAnywhere = Object.values(prev).some(msgs => msgs.some(m => m.runId === triggerId && !m.isSilent && !m.isError && m.sender === 'bia'));
                if (sentAnywhere) {
                    return prev;
                }
            }

            return {
              ...prev,
              [chatId]: [...currentMsgs, {
                id: log.triggerId + '-end',
                chatId: chatId,
                text: text,
                sender: 'bia',
                runId: triggerId,
                time: new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                isSilent,
                isError
              }]
            };
          });

          setTraces(prev => {
            const current = prev[triggerId] || [];
            return {
              ...prev,
              [triggerId]: [...current, {
                id: log.triggerId + '-output',
                type: 'output',
                title: 'Saída Final',
                subtitle: log.data.responseText ? 'Mensagem enviada' : 'Ação concluída',
                tint: 'green',
                timestamp: log.timestamp
              }]
            };
          });

          setInspectors(prev => ({
            ...prev,
            [log.triggerId + '-output']: {
              context: 'Finalização do ciclo',
              memory: 'N/A',
              agentState: log.data,
              modelOutput: {},
              logs: `Tempo de duração: ${log.data.durationMs ? log.data.durationMs + 'ms' : 'N/A'}`
            }
          }));
        }


        // Handle OUTBOUND_MESSAGE
        if (log.event === 'OUTBOUND_MESSAGE') {
          const rawChatId = log.data.chatJid;
          if (rawChatId) {
            const chatId = getCanonicalChatId(rawChatId);
            upsertChat(chatId, rawChatId, log.timestamp, log.data.text);
            
            setMessages(prev => {
              const currentMsgs = prev[chatId] || [];
              if (currentMsgs.some(m => m.runId === triggerId && m.text === log.data.text && m.sender === 'bia')) {
                return prev;
              }
              return {
                ...prev,
                [chatId]: [...currentMsgs, {
                  id: uniqueNodeId(log.timestamp) + '-outbound',
                  chatId: chatId,
                  text: log.data.text || '',
                  sender: 'bia',
                  runId: triggerId,
                  time: new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                  isSilent: false,
                  isError: false
                }]
              };
            });

            setTraces(prev => {
              const current = prev[triggerId] || [];
              return {
                ...prev,
                [triggerId]: [...current, {
                  id: uniqueNodeId(log.timestamp) + '-trace-outbound',
                  type: 'output',
                  title: 'Envio de Mensagem',
                  subtitle: `Para: ${chatId.split('@')[0]}`,
                  tint: 'green',
                  timestamp: log.timestamp
                }]
              };
            });
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
            if (evt) processLogEvent(evt as LogEvent);
          });
        }
        
        // Connect to SSE only after history is processed
        eventSource = new EventSource('http://localhost:3001/api/stream');
        eventSource.onopen = () => setConnected(true);
        eventSource.onerror = () => setConnected(false);
        
        eventSource.onmessage = (e) => {
          try {
            const rawLog = JSON.parse(e.data);
            if (rawLog.type === 'CONNECTED') return;
            processLogEvent(rawLog as LogEvent);
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
