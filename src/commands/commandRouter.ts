import { createTopic, getRecentTopics } from '../memory/topics.js';
import { getTasksForChat } from '../memory/tasks.js';
import { getRoutinesForChat } from '../memory/routines.js';
import { addVectorMemory, searchVectorMemory } from '../memory/vectorMemory.js';
import { getMemory } from '../memory/coreMemory.js';
import { addIgnoredGroup, removeIgnoredGroup, isGroupIgnored } from '../config/ignoredGroups.js';
import { isTrustedChat, listTrustedChats, MASTER_JIDS } from '../memory/security.js';
import { logger } from '../utils/logger.js';
import { getLastTurnEvents, formatAuditExplanation } from '../utils/executionAudit.js';

// Mapa em memória de override de modelo por chat
const chatModelOverrides = new Map<string, string>();

export function getChatModelOverride(chatJid: string): string | undefined {
  return chatModelOverrides.get(chatJid);
}

export function isCommand(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('!');
}

export interface CommandContext {
  text: string;
  chatJid: string;
  userJid: string;
  accountName: string;
  isGroup: boolean;
  sock: any;
  clearQueue?: () => void;
}

export async function handleCommand(ctx: CommandContext): Promise<boolean> {
  const trimmed = ctx.text.trim();
  if (!isCommand(trimmed)) return false;

  const parts = trimmed.substring(1).trim().split(/\s+/);
  const commandName = parts[0].toLowerCase();
  const argsText = parts.slice(1).join(' ');

  logger.info(`[COMMAND ROUTER] Executando comando: /${commandName} para ${ctx.chatJid}`);

  try {
    switch (commandName) {
      case 'novo':
      case 'limpar':
      case 'reset': {
        await createTopic(ctx.chatJid, 'Nova Conversa');
        await ctx.sock.sendMessage(ctx.chatJid, {
          text: `🧹 *Contexto Zerado!*\n\nIniciamos um novo tópico de conversa. A memória de longo prazo (perfil e RAG) continua salva, mas a janela recente foi limpa.`
        });
        return true;
      }

      case 'status': {
        const recent = await getRecentTopics(ctx.chatJid, 1);
        const activeTopic = recent[0]?.title || 'Conversa Geral';
        const isTrusted = await isTrustedChat(ctx.chatJid);
        const isIgnored = isGroupIgnored(ctx.chatJid);
        const modelOverride = chatModelOverrides.get(ctx.chatJid) || 'Padrão (Gemini Flash)';
        const uptimeMin = Math.floor(process.uptime() / 60);

        const statusMsg = `🤖 *Status do Sistema - Bia*\n\n` +
          `• *Tópico Ativo:* ${activeTopic}\n` +
          `• *Chat Confiável:* ${isTrusted ? 'Sim ✅' : 'Não 🔒'}\n` +
          `• *Status do Chat:* ${isIgnored ? 'Silenciado 🔇' : 'Ativo 🔊'}\n` +
          `• *Modelo Ativo:* ${modelOverride}\n` +
          `• *Uptime:* ${uptimeMin} minuto(s)\n` +
          `• *Conta Ativa:* ${ctx.accountName}\n` +
          `• *Versão Node:* ${process.version}`;

        await ctx.sock.sendMessage(ctx.chatJid, { text: statusMsg });
        return true;
      }

      case 'cancelar':
      case 'stop': {
        if (ctx.clearQueue) {
          ctx.clearQueue();
        }
        await ctx.sock.sendMessage(ctx.chatJid, {
          text: `🛑 *Operação Cancelada!*\nA fila de mensagens e o processamento em andamento foram interrompidos para este chat.`
        });
        return true;
      }

      case 'hoje':
      case 'agenda': {
        const todayStr = new Date().toLocaleDateString('pt-BR');
        const tasks = await getTasksForChat(ctx.chatJid, 'pending', undefined, true);
        const routines = await getRoutinesForChat(ctx.chatJid);

        let msg = `📅 *Agenda & Resumo do Dia (${todayStr})*\n\n`;

        msg += `📋 *Tarefas Pendentes (${tasks.length}):*\n`;
        if (tasks.length === 0) {
          msg += `_Nenhuma tarefa pendente._\n`;
        } else {
          tasks.slice(0, 7).forEach(t => {
            msg += `• [ID ${t.id}] ${t.title} (${t.urgency})\n`;
          });
        }

        msg += `\n⏰ *Lembretes & Rotinas Ativas (${routines.length}):*\n`;
        if (routines.length === 0) {
          msg += `_Nenhuma rotina ativa._\n`;
        } else {
          routines.forEach(r => {
            msg += `• [ID ${r.id}] Cron: \`${r.cronExpression}\` → ${r.prompt}\n`;
          });
        }

        await ctx.sock.sendMessage(ctx.chatJid, { text: msg });
        return true;
      }

      case 'tarefas':
      case 'pendencias': {
        const tasks = await getTasksForChat(ctx.chatJid, 'pending', undefined, true);
        if (tasks.length === 0) {
          await ctx.sock.sendMessage(ctx.chatJid, { text: `📋 *Lista de Tarefas*\n\nNenhuma tarefa pendente encontrada!` });
          return true;
        }

        let msg = `📋 *Tarefas Pendentes (${tasks.length}):*\n\n`;
        tasks.forEach(t => {
          msg += `• *[ID ${t.id}]* ${t.title}\n  └ Categoria: ${t.category} | Urgência: ${t.urgency}${t.dueDate ? ` | Prazo: ${t.dueDate}` : ''}\n`;
        });
        await ctx.sock.sendMessage(ctx.chatJid, { text: msg });
        return true;
      }

      case 'lembretes':
      case 'rotinas': {
        const routines = await getRoutinesForChat(ctx.chatJid);
        if (routines.length === 0) {
          await ctx.sock.sendMessage(ctx.chatJid, { text: `⏰ *Rotinas & Lembretes*\n\nNenhum lembrete ou rotina ativa agendada.` });
          return true;
        }

        let msg = `⏰ *Rotinas & Lembretes Ativos (${routines.length}):*\n\n`;
        routines.forEach(r => {
          msg += `• *[ID ${r.id}]* \`${r.cronExpression}\`\n  └ Prompt: ${r.prompt}\n`;
        });
        await ctx.sock.sendMessage(ctx.chatJid, { text: msg });
        return true;
      }

      case 'guardar':
      case 'lembrar': {
        if (!argsText) {
          await ctx.sock.sendMessage(ctx.chatJid, { text: `⚠️ *Uso incorreto.* Envie: \`/guardar <informação a ser salva>\`` });
          return true;
        }

        await addVectorMemory(ctx.chatJid, argsText, 'anotacao');
        await ctx.sock.sendMessage(ctx.chatJid, {
          text: `🧠 *Memória Salva com Sucesso!*\n\nGuardo: "${argsText}"`
        });
        return true;
      }

      case 'buscar': {
        if (!argsText) {
          await ctx.sock.sendMessage(ctx.chatJid, { text: `⚠️ *Uso incorreto.* Envie: \`/buscar <termo>\`` });
          return true;
        }

        const results = await searchVectorMemory(argsText, 5, ctx.chatJid, true);
        if (!results || results.length === 0) {
          await ctx.sock.sendMessage(ctx.chatJid, { text: `🔍 *Busca na Memória*\n\nNenhum resultado encontrado para "${argsText}".` });
          return true;
        }

        let msg = `🔍 *Resultados na Memória RAG para "${argsText}":*\n\n`;
        results.slice(0, 5).forEach((r: any, idx: number) => {
          const content = typeof r === 'string' ? r : (r.content || JSON.stringify(r));
          msg += `${idx + 1}. ${content}\n\n`;
        });

        await ctx.sock.sendMessage(ctx.chatJid, { text: msg.trim() });
        return true;
      }

      case 'perfil': {
        const memoryContent = await getMemory(ctx.chatJid, true);
        await ctx.sock.sendMessage(ctx.chatJid, {
          text: `👤 *Memória Core de Perfil (Bia)*\n\n${memoryContent}`
        });
        return true;
      }

      case 'silenciar':
      case 'ignorar': {
        addIgnoredGroup(ctx.chatJid, ctx.isGroup ? 'Grupo' : 'Chat Privado');
        await ctx.sock.sendMessage(ctx.chatJid, {
          text: `🔇 *Chat Silenciado!*\nA Bia não responderá a mensagens neste chat até que seja reativada com \`/ativar\`.`
        });
        return true;
      }

      case 'ativar': {
        removeIgnoredGroup(ctx.chatJid);
        await ctx.sock.sendMessage(ctx.chatJid, {
          text: `🔊 *Chat Reativado!*\nA Bia voltou a responder normalmente neste chat.`
        });
        return true;
      }

      case 'confiaveis':
      case 'segurança':
      case 'seguranca': {
        const isMaster = MASTER_JIDS.includes(ctx.userJid);
        const trusted = await listTrustedChats();

        let msg = `🛡️ *Painel de Segurança*\n\n`;
        msg += `• *Seu Status:* ${isMaster ? 'Master / Administrador 👑' : 'Usuário Comum'}\n`;
        msg += `• *Chats de Confiança (${trusted.length}):*\n`;
        trusted.forEach(t => {
          msg += `  └ \`${t.jid}\`\n`;
        });

        await ctx.sock.sendMessage(ctx.chatJid, { text: msg });
        return true;
      }

      case 'modelo': {
        const chosen = argsText.toLowerCase();
        if (chosen.includes('flash') || chosen.includes('fast')) {
          chatModelOverrides.set(ctx.chatJid, 'Gemini 2.5 Flash');
          await ctx.sock.sendMessage(ctx.chatJid, { text: `⚡ Modelo alterado para *Gemini 2.5 Flash* (Respostas Rápidas).` });
        } else if (chosen.includes('pro')) {
          chatModelOverrides.set(ctx.chatJid, 'Gemini 2.5 Pro');
          await ctx.sock.sendMessage(ctx.chatJid, { text: `🧠 Modelo alterado para *Gemini 2.5 Pro* (Alta Precisão).` });
        } else if (chosen.includes('deepseek') || chosen.includes('think')) {
          chatModelOverrides.set(ctx.chatJid, 'DeepSeek R1 Thinking');
          await ctx.sock.sendMessage(ctx.chatJid, { text: `🎓 Modelo alterado para *DeepSeek R1 Thinking* (Raciocínio Profundo).` });
        } else {
          await ctx.sock.sendMessage(ctx.chatJid, {
            text: `⚠️ Opções de modelo disponíveis:\n• \`/modelo flash\` (Padrão/Rápido)\n• \`/modelo pro\` (Complexo)\n• \`/modelo deepseek\` (Raciocínio R1)`
          });
        }
        return true;
      }

      case 'explicar': {
        const events = getLastTurnEvents(ctx.chatJid);
        const explanation = formatAuditExplanation(events);
        await ctx.sock.sendMessage(ctx.chatJid, { text: explanation });
        return true;
      }

      case 'ajuda':
      case 'comandos':
      case 'help': {
        const menu = `🤖 *Menu de Comandos da Bia*\n\n` +
          `🧹 *Gestão de Sessão*\n` +
          `• \`/novo\` ou \`/limpar\` : Zera o histórico da conversa recente\n` +
          `• \`/status\` : Exibe informações técnicas e uptime\n` +
          `• \`/cancelar\` : Interrompe tarefas/mensagens em andamento\n\n` +
          `📋 *Produtividade*\n` +
          `• \`/hoje\` ou \`/agenda\` : Resumo do dia (tarefas + lembretes)\n` +
          `• \`/tarefas\` : Lista tarefas pendentes\n` +
          `• \`/lembretes\` : Lista lembretes e rotinas ativas\n\n` +
          `🧠 *Memória RAG*\n` +
          `• \`/guardar <texto>\` : Salva um fato/anotação na memória RAG\n` +
          `• \`/buscar <termo>\` : Procura informações salvas no banco\n` +
          `• \`/perfil\` : Exibe a memória de perfil do usuário\n\n` +
          `🛡️ *Segurança & Notificações*\n` +
          `• \`/silenciar\` : Desativa respostas automáticas no chat\n` +
          `• \`/ativar\` : Reativa respostas no chat\n` +
          `• \`/segurança\` : Exibe os chats de confiança\n` +
          `• \`/aprovar <numero>\` : Aprova número para envio sem confirmação\n\n` +
          `⚙️ *Configuração*\n` +
          `• \`/modelo [flash|pro|deepseek]\` : Alterna o modelo LLM do chat\n` +
          `• \`/ajuda\` : Exibe este menu`;

        await ctx.sock.sendMessage(ctx.chatJid, { text: menu });
        return true;
      }

      default:
        await ctx.sock.sendMessage(ctx.chatJid, {
          text: `⚠️ Comando \`/${commandName}\` não reconhecido. Digite \`/ajuda\` para ver a lista de comandos disponíveis.`
        });
        return true;
    }
  } catch (error: any) {
    logger.error(`[COMMAND ROUTER] Erro ao executar comando /${commandName}:`, error);
    await ctx.sock.sendMessage(ctx.chatJid, {
      text: `❌ Ocorreu um erro ao processar o comando \`/${commandName}\`: ${error.message || 'Erro desconhecido'}`
    });
    return true;
  }
}
