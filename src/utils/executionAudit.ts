/**
 * Módulo de Auditoria de Execução & Auto-Explicação (/explicar)
 */

export interface ToolExecutionEvent {
  toolName: string;
  args: Record<string, any>;
  resultSummary?: string;
  timestamp: number;
}

// Armazena em memória os eventos de execução do turno recente por chatJid / threadId
const auditStore = new Map<string, ToolExecutionEvent[]>();

/**
 * Normaliza a chave do chat/thread para agrupamento de auditoria.
 */
function normalizeKey(key: string): string {
  if (!key) return 'global';
  return key.includes('_') ? key.split('_')[0] : key;
}

/**
 * Registra a execução de uma ferramenta no histórico do turno.
 */
export function recordExecutionEvent(
  key: string,
  event: Omit<ToolExecutionEvent, 'timestamp'>
): void {
  const normKey = normalizeKey(key);
  const events = auditStore.get(normKey) || [];
  events.push({
    ...event,
    timestamp: Date.now(),
  });
  auditStore.set(normKey, events);
}

/**
 * Retorna os eventos registrados do turno recente.
 */
export function getLastTurnEvents(key: string): ToolExecutionEvent[] {
  const normKey = normalizeKey(key);
  return auditStore.get(normKey) || [];
}

/**
 * Limpa o histórico de auditoria do turno.
 */
export function clearTurnEvents(key: string): void {
  const normKey = normalizeKey(key);
  auditStore.delete(normKey);
}

/**
 * Traduz nomes de ferramentas para descrições em português amigáveis.
 */
function getFriendlyToolName(toolName: string): string {
  const map: Record<string, string> = {
    listRecentChats: 'Histórico de conversas recentes do WhatsApp',
    getChatHistory: 'Histórico de mensagens do chat',
    searchChatByName: 'Busca de contato ou grupo por nome no WhatsApp',
    searchGroups: 'Busca de grupos no WhatsApp',
    sendPersonalMessage: 'Envio de mensagem via conta pessoal',
    list_recent_chats: 'Histórico de conversas recentes do WhatsApp',
    get_chat_history: 'Histórico de mensagens do chat',
    search_chat_by_name: 'Busca de contato ou grupo por nome no WhatsApp',
    search_groups: 'Busca de grupos no WhatsApp',
    send_personal_message: 'Envio de mensagem via conta pessoal',
    whatsappAgent: 'Agente especialista do WhatsApp',

    addTask: 'Criação de tarefa',
    listTasks: 'Consulta à lista de tarefas',
    completeTask: 'Conclusão de tarefa',
    deleteTask: 'Exclusão de tarefa',
    add_task: 'Criação de tarefa',
    list_tasks: 'Consulta à lista de tarefas',
    complete_task: 'Conclusão de tarefa',
    delete_task: 'Exclusão de tarefa',
    taskAgent: 'Agente especialista de Tarefas',

    createRoutine: 'Criação de lembrete/rotina',
    listRoutines: 'Consulta a lembretes e rotinas',
    deleteRoutine: 'Exclusão de lembrete/rotina',
    create_routine: 'Criação de lembrete/rotina',
    list_routines: 'Consulta a lembretes e rotinas',
    delete_routine: 'Exclusão de lembrete/rotina',
    routineAgent: 'Agente especialista de Rotinas',

    readMemory: 'Leitura da memória central',
    deleteFromCoreMemory: 'Remoção de trecho da memória central',
    searchSemanticMemory: 'Busca semântica na memória de longo prazo (RAG)',
    storeSemanticMemory: 'Armazenamento de novo fato na memória RAG',
    searchEventSummary: 'Busca em resumos de eventos passados',
    read_memory: 'Leitura da memória central',
    search_semantic_memory: 'Busca semântica na memória de longo prazo (RAG)',
    store_semantic_memory: 'Armazenamento de novo fato na memória RAG',
    search_event_summary: 'Busca em resumos de eventos passados',
    memoryAgent: 'Agente especialista de Memória',

    googleSearch: 'Pesquisa no Google',
    openWebpage: 'Leitura de página web',
    googleShopping: 'Consulta de produtos e preços (Shopping)',
    google_search: 'Pesquisa no Google',
    open_webpage: 'Leitura de página web',
    google_shopping: 'Consulta de produtos e preços (Shopping)',
    searchAgent: 'Agente de Busca Web',
    shoppingAgent: 'Agente de Compras e Preços',

    weather: 'Consulta de previsão do tempo (OpenMeteo)',
    weatherAgent: 'Agente especialista de Clima',

    calendarAgent: 'Agente especialista do Google Calendar',
    calendar_list_events: 'Consulta a eventos no Google Calendar',
    calendar_create_event: 'Criação de evento no Google Calendar',
    get_user_email: 'Consulta do e-mail principal do usuário',
    gmailAgent: 'Agente especialista do Gmail',
    gmail_list_emails: 'Consulta a mensagens do Gmail',
    gmail_send_email: 'Envio de e-mail via Gmail',
    docsAgent: 'Agente especialista do Google Docs',
    sheetsAgent: 'Agente especialista do Google Sheets',
  };

  return map[toolName] || toolName;
}

/**
 * Formata os parâmetros de forma legível.
 */
function formatArgs(args: Record<string, any>): string {
  if (!args || Object.keys(args).length === 0) return '';
  const entries = Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(', ');
  return ` (${entries})`;
}

/**
 * Gera a resposta formatada de auto-explicação (/explicar).
 */
export function formatAuditExplanation(events: ToolExecutionEvent[]): string {
  if (!events || events.length === 0) {
    return (
      `🧠 *Como processei seu pedido recente:*\n\n` +
      `Não precisei consultar ferramentas externas nem banco de dados. ` +
      `Respondi usando apenas raciocínio direto e o contexto recente da nossa conversa.`
    );
  }

  let text = `🧠 *Como processei seu pedido anterior:*\n\n`;
  events.forEach((evt, idx) => {
    const name = getFriendlyToolName(evt.toolName);
    const argsStr = formatArgs(evt.args);
    text += `${idx + 1}. Consultai: *${name}*${argsStr}\n`;
    if (evt.resultSummary) {
      text += `   └ *Resultado:* ${evt.resultSummary.substring(0, 120)}${evt.resultSummary.length > 120 ? '...' : ''}\n`;
    }
  });

  text += `\nCom base nesses dados, formatei a resposta direta para você!`;
  return text;
}
