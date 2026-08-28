/**
 * Utilitário de Selos Visuais de Transparência de Ferramentas e Agentes (Tool & Agent Seals)
 */

export const AGENT_SEAL_MAP: Record<string, string> = {
  // Google Workspace Agents
  calendarAgent: '📅',
  gmailAgent: '📧',
  sheetsAgent: '📊',
  docsAgent: '📝',

  // System & Communication Specialist Agents
  searchAgent: '🔍',
  shoppingAgent: '🛍️',
  routineAgent: '⏰',
  memoryAgent: '🧠',
  taskAgent: '📋',
  securityAgent: '🛡️',
  whatsappAgent: '💬',
  reasoningAgent: '💡',
  weatherAgent: '🌦️',
};

export const TOOL_SEAL_MAP: Record<string, string> = {
  // 💬 WhatsApp
  whatsappAgent: '💬',
  listRecentChats: '💬',
  getChatHistory: '💬',
  searchChatByName: '💬',
  searchGroups: '💬',
  sendPersonalMessage: '💬',
  list_recent_chats: '💬',
  get_chat_history: '💬',
  search_chat_by_name: '💬',
  search_groups: '💬',
  send_personal_message: '💬',

  // 📋 Tarefas
  taskAgent: '📋',
  addTask: '📋',
  listTasks: '📋',
  completeTask: '📋',
  deleteTask: '📋',
  add_task: '📋',
  list_tasks: '📋',
  complete_task: '📋',
  delete_task: '📋',

  // ⏰ Rotinas
  routineAgent: '⏰',
  createRoutine: '⏰',
  listRoutines: '⏰',
  deleteRoutine: '⏰',
  create_routine: '⏰',
  list_routines: '⏰',
  delete_routine: '⏰',

  // 🧠 Memória / RAG
  memoryAgent: '🧠',
  readMemory: '🧠',
  deleteFromCoreMemory: '🧠',
  deleteSemanticMemory: '🧠',
  delete_semantic_memory: '🧠',
  consolidateMemory: '🧠',
  consolidate_memory: '🧠',
  searchSemanticMemory: '🧠',
  storeSemanticMemory: '🧠',
  searchEventSummary: '🧠',
  read_memory: '🧠',
  search_semantic_memory: '🧠',
  store_semantic_memory: '🧠',
  search_event_summary: '🧠',

  // 🔍 Busca Web / Shopping
  searchAgent: '🔍',
  shoppingAgent: '🛍️',
  googleSearch: '🔍',
  openWebpage: '🔍',
  googleShopping: '🛍️',
  google_search: '🔍',
  open_webpage: '🔍',
  google_shopping: '🛍️',

  // 🌦️ Clima
  weatherAgent: '🌦️',
  weather: '🌦️',
  get_weather: '🌦️',

  // 🛡️ Segurança
  securityAgent: '🛡️',
  add_trusted_chat: '🛡️',
  remove_trusted_chat: '🛡️',
  check_trust: '🛡️',
  list_trusted_chats: '🛡️',
  get_master_info: '🛡️',
  connect_personal_account: '🛡️',
  disconnect_personal_account: '🛡️',
  check_personal_account_status: '🛡️',
  ignore_group: '🛡️',
  unignore_group: '🛡️',
  list_ignored_groups: '🛡️',
  enable_auto_reply: '🛡️',
  disable_auto_reply: '🛡️',
  list_auto_reply_chats: '🛡️',

  // 📅📧📊📝 Google Workspace MCP Tools (fallbacks)
  calendar: '📅',
  gmail: '📧',
  sheets: '📊',
  docs: '📝',
};

const ORDERED_AGENT_SEALS = ['📅', '📧', '📊', '📝', '🔍', '🛍️', '⏰', '🧠', '📋', '🛡️', '💬', '💡', '🌦️'];
const ORDERED_TOOL_SEALS = ['📅', '📧', '📊', '📝', '🔍', '🛍️', '⏰', '🧠', '📋', '🛡️', '💬', '💡', '🌦️'];

/**
 * Retorna os emojis dos selos de agentes executados.
 */
export function getAgentSeals(executedAgents: string[]): string {
  if (!executedAgents || executedAgents.length === 0) {
    return '';
  }

  const triggeredEmojis = new Set<string>();
  for (const item of executedAgents) {
    const seal = AGENT_SEAL_MAP[item];
    if (seal) {
      triggeredEmojis.add(seal);
    }
  }

  if (triggeredEmojis.size === 0) {
    return '';
  }

  return ORDERED_AGENT_SEALS.filter((emoji) => triggeredEmojis.has(emoji)).join(' ');
}

/**
 * Retorna os emojis dos selos de ferramentas executadas.
 */
export function getToolSeals(executedTools: string[]): string {
  if (!executedTools || executedTools.length === 0) {
    return '';
  }

  const triggeredEmojis = new Set<string>();
  for (const item of executedTools) {
    let seal = TOOL_SEAL_MAP[item];
    if (!seal) {
      const lower = item.toLowerCase();
      if (lower.includes('calendar')) seal = '📅';
      else if (lower.includes('gmail')) seal = '📧';
      else if (lower.includes('sheets') || lower.includes('spreadsheet')) seal = '📊';
      else if (lower.includes('docs') || lower.includes('document')) seal = '📝';
    }
    if (seal) {
      triggeredEmojis.add(seal);
    }
  }

  if (triggeredEmojis.size === 0) {
    return '';
  }

  return ORDERED_TOOL_SEALS.filter((emoji) => triggeredEmojis.has(emoji)).join(' ');
}

/**
 * Anexa os selos visuais no rodapé da mensagem separando agentes e ferramentas.
 * Formato Agentes: 🤖: 📅 📧
 * Formato Ferramentas: 🛠️: 🔍 🧠
 */
export function applyToolSeals(
  text: string,
  executedToolsOrItems?: string[] | { tools?: string[]; agents?: string[] },
  executedAgentsInput?: string[]
): string {
  if (!text) return text;

  let toolsList: string[] = [];
  let agentsList: string[] = [];

  if (Array.isArray(executedToolsOrItems)) {
    if (Array.isArray(executedAgentsInput)) {
      toolsList = executedToolsOrItems;
      agentsList = executedAgentsInput;
    } else {
      for (const item of executedToolsOrItems) {
        if (AGENT_SEAL_MAP[item] || item.endsWith('Agent')) {
          agentsList.push(item);
        } else {
          toolsList.push(item);
        }
      }
    }
  } else if (executedToolsOrItems && typeof executedToolsOrItems === 'object') {
    toolsList = executedToolsOrItems.tools || [];
    agentsList = executedToolsOrItems.agents || [];
  }

  const agentSeals = getAgentSeals(agentsList);

  // Evita duplicar no rodapé de ferramentas selos de emojis já exibidos na linha de agentes
  const agentEmojiSet = new Set(agentSeals.split(' ').filter(Boolean));
  const rawToolEmojis = getToolSeals(toolsList).split(' ').filter(Boolean);
  const filteredToolEmojis = rawToolEmojis.filter((emoji) => !agentEmojiSet.has(emoji));
  const toolSeals = filteredToolEmojis.join(' ');

  if (!agentSeals && !toolSeals) return text;

  const lines: string[] = [];
  if (agentSeals) {
    lines.push(`🤖: ${agentSeals}`);
  }
  if (toolSeals) {
    lines.push(`🛠️: ${toolSeals}`);
  }

  const footer = lines.join('\n');
  const trimmed = text.trim();

  if (trimmed.endsWith(footer)) return text;

  return `${trimmed}\n\n${footer}`;
}
