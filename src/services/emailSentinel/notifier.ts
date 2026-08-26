import { notifyMaster } from '../../transport/whatsapp.js';
import { logger } from '../../utils/logger.js';
import { EmailAnalysisResult } from './types.js';

/**
 * Formata a mensagem de resumo executivo dos e-mails importantes no tom da Bia.
 */
export function formatNotificationMessage(
  importantEmails: EmailAnalysisResult[]
): string | null {
  if (!importantEmails || importantEmails.length === 0) {
    return null;
  }

  const intro = importantEmails.length === 1
    ? "Oi Luiz! Chegou um e-mail recente que precisa da sua atenção:"
    : `Oi Luiz! Passei o olho na sua caixa de entrada e separei ${importantEmails.length} e-mails que precisam da sua atenção:`;

  const emailBlocks = importantEmails.map((item) => {
    const priorityIcon = item.priority === 'HIGH' ? '🔴' : '🟡';
    return (
      `${priorityIcon} *${item.sender.trim()}* — *${item.subject.trim()}*\n` +
      `• *O que é:* ${item.summary.trim()}\n` +
      `• *Ação sugerida:* ${item.actionRequired.trim()}`
    );
  }).join("\n\n");

  return `${intro}\n\n${emailBlocks}`;
}

/**
 * Formata e envia a notificação consolidada no WhatsApp do Luiz caso haja e-mails importantes.
 * Se não houver nada importante, permanece em silêncio absoluto.
 */
export async function notifyImportantEmails(
  importantEmails: EmailAnalysisResult[],
  customNotifier?: (text: string) => Promise<void>
): Promise<boolean> {
  const message = formatNotificationMessage(importantEmails);
  if (!message) {
    logger.info("[EMAIL_SENTINEL] Nenhum e-mail prioritário identificado na rodada. Permanecendo em silêncio.");
    return false;
  }

  logger.info(`[EMAIL_SENTINEL] Disparando alerta consolidado para ${importantEmails.length} e-mail(s) importante(s)...`);

  try {
    if (customNotifier) {
      await customNotifier(message);
    } else {
      await notifyMaster(message);
    }
    logger.info("[EMAIL_SENTINEL] Notificação consolidada enviada com sucesso no WhatsApp do Master.");
    return true;
  } catch (err: any) {
    logger.error("[EMAIL_SENTINEL] Erro ao enviar notificação consolidada via notifyMaster:", err.message || err);
    return false;
  }
}
