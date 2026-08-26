import cron from 'node-cron';
import { logger, generateTriggerId, runWithTriggerContext } from '../../utils/logger.js';
import {
  initEmailSentinelTables,
  recordProcessedEmailsBatch,
  recordProcessedEmail,
} from '../../memory/emailSentinel.js';
import { fetchUnprocessedUnreadEmails } from './gmailFetcher.js';
import { applyHeuristicFilter } from './heuristicFilter.js';
import { analyzeEmailBatchWithLLM } from './batchAnalyzer.js';
import { notifyImportantEmails } from './notifier.js';
import { SentinelScanStats } from './types.js';

let cronJob: ReturnType<typeof cron.schedule> | null = null;
let isScanInProgress = false;

/**
 * Executa um ciclo completo de varredura do Sentinela de E-mail:
 * 1. Busca e-mails não lidos novos.
 * 2. Etapa 1: Filtro Heurístico e Metadados (descarta newsletters, spam, 2FA, regras de ignore).
 * 3. Etapa 2: Análise em Lote com LLM (1 única chamada consolidada para os candidatos).
 * 4. Dispara alerta no WhatsApp via notifyMaster caso haja e-mails importantes.
 * 5. Registra tudo no SQLite para evitar duplicidade.
 */
export async function runSentinelScan(options: { maxResults?: number } = {}): Promise<SentinelScanStats> {
  if (isScanInProgress) {
    logger.warn("[EMAIL_SENTINEL] Varredura já em andamento. Pulando execução concorrente.");
    return {
      totalUnread: 0,
      newUnread: 0,
      heuristicFiltered: 0,
      analyzedWithLLM: 0,
      importantEmailsCount: 0,
      alertSent: false,
      timestamp: new Date().toISOString(),
    };
  }

  isScanInProgress = true;
  const startTime = Date.now();
  logger.info("[EMAIL_SENTINEL] Iniciando ciclo de monitoramento do Sentinela de E-mails...");

  try {
    await initEmailSentinelTables();

    // 1. Busca e-mails não lidos ainda não processados
    const newEmails = await fetchUnprocessedUnreadEmails(options.maxResults || 50);
    const newUnreadCount = newEmails.length;

    if (newUnreadCount === 0) {
      logger.info("[EMAIL_SENTINEL] Nenhum e-mail novo para analisar nesta rodada.");
      return {
        totalUnread: 0,
        newUnread: 0,
        heuristicFiltered: 0,
        analyzedWithLLM: 0,
        importantEmailsCount: 0,
        alertSent: false,
        timestamp: new Date().toISOString(),
      };
    }

    // 2. Etapa 1: Filtragem por Heurísticas e Metadados
    const { passed, filtered } = await applyHeuristicFilter(newEmails);
    logger.info(`[EMAIL_SENTINEL] Etapa 1 concluída: ${passed.length} passaram, ${filtered.length} descartados por heurística/regras.`);

    // Grava histórico dos e-mails descartados na Etapa 1
    if (filtered.length > 0) {
      await recordProcessedEmailsBatch(
        filtered.map(f => ({
          emailId: f.email.id,
          threadId: f.email.threadId,
          sender: f.email.sender,
          subject: f.email.subject,
          snippet: f.email.snippet,
          classification: 'ignored_heuristic',
          reason: f.reason,
        }))
      );
    }

    if (passed.length === 0) {
      logger.info("[EMAIL_SENTINEL] Nenhum e-mail passou para a Etapa 2. Zero chamadas de LLM necessárias.");
      return {
        totalUnread: newUnreadCount,
        newUnread: newUnreadCount,
        heuristicFiltered: filtered.length,
        analyzedWithLLM: 0,
        importantEmailsCount: 0,
        alertSent: false,
        timestamp: new Date().toISOString(),
      };
    }

    // 3. Etapa 2: Análise Consolidada em Lote com LLM & Notificação
    const triggerId = generateTriggerId();
    const triggerCtx: any = {
      triggerId,
      triggerType: 'system_inject',
      threadId: `main_sentinel_${triggerId}`,
      chatJid: '5519997064504@s.whatsapp.net',
      chatName: 'Luiz',
      accountName: 'main',
      messageContent: `[Sentinela de E-mail] Análise em lote de ${passed.length} e-mails`,
      startedAt: new Date().toISOString()
    };

    let analyzedResults: any[] = [];
    let importantEmails: any[] = [];
    let alertSent = false;

    await runWithTriggerContext(triggerCtx, async () => {
      analyzedResults = await analyzeEmailBatchWithLLM(passed);
      importantEmails = analyzedResults.filter(item => item.isImportant);

      // Grava histórico dos e-mails analisados na Etapa 2
      for (const item of analyzedResults) {
        const emailMeta = passed.find(p => p.id === item.emailId);
        await recordProcessedEmail({
          emailId: item.emailId,
          threadId: emailMeta?.threadId,
          sender: item.sender || emailMeta?.sender,
          subject: item.subject || emailMeta?.subject,
          snippet: emailMeta?.snippet,
          classification: item.isImportant ? 'important' : 'ignored_llm',
          reason: `${item.summary} | Ação: ${item.actionRequired} | Motivo: ${item.reason}`,
        });
      }

      // 4. Notificação Consolidada no WhatsApp
      if (importantEmails.length > 0) {
        alertSent = await notifyImportantEmails(importantEmails);
      } else {
        logger.info("[EMAIL_SENTINEL] Análise em lote não identificou e-mails críticos. Permanecendo em silêncio.");
      }
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[EMAIL_SENTINEL] Ciclo finalizado em ${duration}s. Importantes: ${importantEmails.length}, Alerta disparado: ${alertSent}`);

    return {
      totalUnread: newUnreadCount,
      newUnread: newUnreadCount,
      heuristicFiltered: filtered.length,
      analyzedWithLLM: analyzedResults.length,
      importantEmailsCount: importantEmails.length,
      alertSent,
      timestamp: new Date().toISOString(),
    };
  } catch (err: any) {
    logger.error("[EMAIL_SENTINEL] Erro durante o ciclo de varredura:", err.message || err);
    return {
      totalUnread: 0,
      newUnread: 0,
      heuristicFiltered: 0,
      analyzedWithLLM: 0,
      importantEmailsCount: 0,
      alertSent: false,
      timestamp: new Date().toISOString(),
    };
  } finally {
    isScanInProgress = false;
  }
}

/**
 * Inicializa o serviço em segundo plano do Sentinela de E-mail.
 */
export async function initEmailSentinel(): Promise<void> {
  const isEnabled = process.env.EMAIL_SENTINEL_ENABLED !== 'false';
  if (!isEnabled) {
    logger.info("[EMAIL_SENTINEL] Sentinela de E-mails desativado por variável de ambiente (EMAIL_SENTINEL_ENABLED=false).");
    return;
  }

  try {
    await initEmailSentinelTables();
    
    // Padrão: roda a cada 30 minutos
    const cronExpression = process.env.EMAIL_SENTINEL_CRON || "*/30 * * * *";

    if (cronJob) {
      cronJob.stop();
    }

    cronJob = cron.schedule(cronExpression, async () => {
      logger.info(`[EMAIL_SENTINEL CRON] Disparando verificação programada de e-mails (${cronExpression})...`);
      try {
        await runSentinelScan();
      } catch (err: any) {
        logger.error("[EMAIL_SENTINEL CRON] Erro no job cron do sentinela:", err);
      }
    });

    logger.info(`[EMAIL_SENTINEL] Sentinela de E-mails ativado e agendado com sucesso. (Cron: ${cronExpression})`);
  } catch (err: any) {
    logger.error("[EMAIL_SENTINEL] Falha ao inicializar o Sentinela de E-mails:", err);
  }
}

/**
 * Desativa o agendamento do Sentinela de E-mail.
 */
export function stopEmailSentinel(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    logger.info("[EMAIL_SENTINEL] Sentinela de E-mails desativado com sucesso.");
  }
}
