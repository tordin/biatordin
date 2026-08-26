import cron from 'node-cron';
import { logger } from '../../utils/logger.js';
import {
  initFollowUpsTable,
  getOverdueWaitingFollowUps,
  getUpcomingPromisedFollowUps,
  markFollowUpNotified,
  updateFollowUp,
  FollowUp
} from '../../memory/followUps.js';
import { notifyMaster } from '../../transport/whatsapp.js';

let cronJob: ReturnType<typeof cron.schedule> | null = null;
let isScanInProgress = false;

function formatFriendlyDueDate(dueDateStr?: string | null): string {
  if (!dueDateStr) return "";
  try {
    const due = new Date(dueDateStr);
    const now = new Date();

    const isToday = due.getDate() === now.getDate() &&
      due.getMonth() === now.getMonth() &&
      due.getFullYear() === now.getFullYear();

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = due.getDate() === tomorrow.getDate() &&
      due.getMonth() === tomorrow.getMonth() &&
      due.getFullYear() === tomorrow.getFullYear();

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = due.getDate() === yesterday.getDate() &&
      due.getMonth() === yesterday.getMonth() &&
      due.getFullYear() === yesterday.getFullYear();

    const hours = due.getHours().toString().padStart(2, '0');
    const minutes = due.getMinutes().toString().padStart(2, '0');
    const timeStr = `${hours}:${minutes}`;

    if (isToday) {
      return `hoje às ${timeStr}`;
    } else if (isTomorrow) {
      return `amanhã às ${timeStr}`;
    } else if (isYesterday) {
      return `ontem às ${timeStr}`;
    } else {
      return due.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo'
      });
    }
  } catch (e) {
    return dueDateStr;
  }
}

export interface FollowUpScanStats {
  overdueWaitingCount: number;
  upcomingPromisedCount: number;
  alertsSent: number;
  timestamp: string;
}

export function formatWaitingAlertMessage(item: FollowUp): string {
  const formattedDate = formatFriendlyDueDate(item.dueDate);
  const prazoMsg = formattedDate ? ` (o prazo combinado era ${formattedDate})` : '';
  return `Luiz, o(a) ${item.contactName} ainda não deu retorno sobre ${item.description}${prazoMsg}. Quer que eu envie uma mensagem educada de cobrança para ele(a) ou você prefere resolver direto?`;
}

export function formatPromisedReminderMessage(item: FollowUp): string {
  const formattedDate = formatFriendlyDueDate(item.dueDate);
  const prazoMsg = formattedDate ? ` até ${formattedDate}` : '';
  return `Lembrete: você combinou de ${item.description} para ${item.contactName}${prazoMsg}.`;
}

/**
 * Executa uma varredura de pendências para alertar o Luiz no WhatsApp:
 * 1. Waiting for Reply vencidos -> sugere cobrança ou resolução direta.
 * 2. Promised by Me com prazo próximo -> lembra com antecedência.
 */
export async function runFollowUpScan(
  customNotifier?: (text: string) => Promise<void>
): Promise<FollowUpScanStats> {
  const notify = customNotifier || notifyMaster;

  if (isScanInProgress) {
    logger.warn("[FOLLOWUP WORKER] Varredura já em andamento. Pulando execução concorrente.");
    return {
      overdueWaitingCount: 0,
      upcomingPromisedCount: 0,
      alertsSent: 0,
      timestamp: new Date().toISOString()
    };
  }

  isScanInProgress = true;
  let alertsSent = 0;

  try {
    await initFollowUpsTable();

    // 1. Avalia Waiting for Reply (Eles me devem) vencidos
    const overdueWaiting = await getOverdueWaitingFollowUps();
    const nowMs = Date.now();

    for (const item of overdueWaiting) {
      // Evita spam: só notifica novamente após 24 horas
      const lastNotifiedMs = item.lastNotifiedAt ? new Date(item.lastNotifiedAt).getTime() : 0;
      const hoursSinceNotification = (nowMs - lastNotifiedMs) / (1000 * 60 * 60);

      if (!item.lastNotifiedAt || hoursSinceNotification >= 24) {
        const alertMsg = formatWaitingAlertMessage(item);

        logger.info(`[FOLLOWUP WORKER] Enviando alerta de Waiting for Reply vencido para pendência ID ${item.id} (${item.contactName}).`);
        await notify(alertMsg);
        await updateFollowUp(item.id, {
          status: 'overdue',
          lastNotifiedAt: new Date().toISOString()
        });
        alertsSent++;
      }
    }

    // 2. Avalia Promised by Me (Eu prometi a eles) com prazo próximo (< 4 horas ou no mesmo dia)
    const upcomingPromised = await getUpcomingPromisedFollowUps(4);

    for (const item of upcomingPromised) {
      if (!item.lastNotifiedAt) {
        const reminderMsg = formatPromisedReminderMessage(item);

        logger.info(`[FOLLOWUP WORKER] Enviando lembrete de Promised by Me próximo para pendência ID ${item.id} (${item.contactName}).`);
        await notify(reminderMsg);
        await markFollowUpNotified(item.id);
        alertsSent++;
      }
    }

    logger.info(`[FOLLOWUP WORKER] Ciclo de follow-up concluído. Vencidos aguardando: ${overdueWaiting.length}, Promessas próximas: ${upcomingPromised.length}, Alertas disparados: ${alertsSent}`);

    return {
      overdueWaitingCount: overdueWaiting.length,
      upcomingPromisedCount: upcomingPromised.length,
      alertsSent,
      timestamp: new Date().toISOString()
    };
  } catch (err: any) {
    logger.error("[FOLLOWUP WORKER] Erro durante o ciclo de varredura:", err.message || err);
    return {
      overdueWaitingCount: 0,
      upcomingPromisedCount: 0,
      alertsSent,
      timestamp: new Date().toISOString()
    };
  } finally {
    isScanInProgress = false;
  }
}

/**
 * Inicializa o worker em segundo plano para o Motor de Follow-Up.
 */
export async function initFollowUpWorker(): Promise<void> {
  const isEnabled = process.env.FOLLOWUP_WORKER_ENABLED !== 'false';
  if (!isEnabled) {
    logger.info("[FOLLOWUP WORKER] Worker de Follow-Up desativado por variável de ambiente (FOLLOWUP_WORKER_ENABLED=false).");
    return;
  }

  try {
    await initFollowUpsTable();

    // Padrão: roda a cada 15 minutos
    const cronExpression = process.env.FOLLOWUP_WORKER_CRON || "*/15 * * * *";

    if (cronJob) {
      cronJob.stop();
    }

    cronJob = cron.schedule(cronExpression, async () => {
      logger.info(`[FOLLOWUP WORKER CRON] Disparando verificação programada de follow-ups (${cronExpression})...`);
      try {
        await runFollowUpScan();
      } catch (err: any) {
        logger.error("[FOLLOWUP WORKER CRON] Erro no job cron do worker de follow-up:", err);
      }
    });

    logger.info(`[FOLLOWUP WORKER] Worker de Follow-Up ativado e agendado com sucesso. (Cron: ${cronExpression})`);
  } catch (err: any) {
    logger.error("[FOLLOWUP WORKER] Falha ao inicializar o Worker de Follow-Up:", err);
  }
}

/**
 * Desativa o agendamento do Worker de Follow-Up.
 */
export function stopFollowUpWorker(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    logger.info("[FOLLOWUP WORKER] Worker de Follow-Up desativado com sucesso.");
  }
}
