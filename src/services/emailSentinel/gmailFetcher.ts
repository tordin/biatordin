import { google } from 'googleapis';
import { logger } from '../../utils/logger.js';
import { areEmailsProcessed } from '../../memory/emailSentinel.js';
import { notifyMaster } from '../../transport/whatsapp.js';
import { EmailMetadata } from './types.js';

let lastAuthWarningSentAt = 0;
const AUTH_WARNING_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 horas

export function isGoogleAuthError(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || err.toString() || '').toLowerCase();
  return (
    msg.includes('invalid_grant') ||
    msg.includes('token has been expired or revoked') ||
    msg.includes('could not refresh access token') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid_client') ||
    msg.includes('unauthorized_client') ||
    err.code === 401 ||
    err.status === 401 ||
    err.response?.status === 401
  );
}

export async function handleGoogleAuthError(err: any): Promise<void> {
  const isAuthErr = isGoogleAuthError(err);
  if (!isAuthErr) return;

  const now = Date.now();
  if (now - lastAuthWarningSentAt < AUTH_WARNING_COOLDOWN_MS) {
    logger.info("[GOOGLE_AUTH] Alerta de reautenticação em cooldown (já enviado recentemente).");
    return;
  }

  lastAuthWarningSentAt = now;
  logger.warn("[GOOGLE_AUTH] Detectada necessidade de reautenticação do Google Workspace. Enviando alerta para o Master...");

  const alertMessage =
    `⚠️ *Alerta da Bia — Autenticação do Google*\n\n` +
    `Luiz, a conexão com sua conta Google (Gmail / Workspace) expirou ou precisa ser reautenticada (erro: *invalid_grant / token expirado*).\n\n` +
    `Enquanto as credenciais não forem renovadas, o Sentinela de E-mails e as consultas ao Gmail/Drive ficarão em pausa.\n` +
    `Por favor, atualize a variável \`GOOGLE_REFRESH_TOKEN\` no arquivo \`.env\` para restabelecer o monitoramento.`;

  try {
    await notifyMaster(alertMessage);
    logger.info("[GOOGLE_AUTH] Notificação de reautenticação enviada com sucesso no WhatsApp do Master.");
  } catch (notifyErr: any) {
    logger.error("[GOOGLE_AUTH] Erro ao enviar notificação de auth para o Master:", notifyErr.message || notifyErr);
  }
}

export async function checkGoogleAuthStatus(): Promise<{
  configured: boolean;
  valid: boolean;
  message: string;
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      configured: false,
      valid: false,
      message: "Credenciais do Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN) não estão preenchidas no .env.",
    };
  }

  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: 'v1', auth });

    const profile = await gmail.users.getProfile({ userId: 'me' });
    lastAuthWarningSentAt = 0; // Conexão saudável

    return {
      configured: true,
      valid: true,
      message: `Conexão com o Google Workspace ativa e autenticada com sucesso! Conta conectada: ${profile.data.emailAddress || 'principal'}.`,
    };
  } catch (err: any) {
    if (isGoogleAuthError(err)) {
      return {
        configured: true,
        valid: false,
        message: `A autenticação com o Google expirou ou foi revogada (${err.message || 'invalid_grant'}). É necessário renovar o GOOGLE_REFRESH_TOKEN no .env.`,
      };
    }
    return {
      configured: true,
      valid: false,
      message: `Erro ao verificar conexão com o Google: ${err.message || err}`,
    };
  }
}

function getGmailClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    logger.warn("[EMAIL_SENTINEL] Credenciais do Google OAuth não configuradas no .env. Ignorando busca no Gmail.");
    return null;
  }

  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    return google.gmail({ version: 'v1', auth });
  } catch (err: any) {
    logger.error("[EMAIL_SENTINEL] Falha ao instanciar cliente do Gmail:", err.message || err);
    return null;
  }
}

function parseFromHeader(fromValue: string): { fromName: string; fromEmail: string } {
  if (!fromValue) return { fromName: "", fromEmail: "" };
  
  const match = fromValue.match(/^(?:"?([^"]*)"?\s)?(?:<?(.+@[^>]+)>?)$/);
  if (match) {
    const fromName = (match[1] || "").trim();
    const fromEmail = (match[2] || "").trim().toLowerCase();
    return {
      fromName: fromName || fromEmail.split('@')[0],
      fromEmail,
    };
  }

  return {
    fromName: fromValue.trim(),
    fromEmail: fromValue.trim().toLowerCase(),
  };
}

function getHeader(headers: any[] | undefined, name: string): string {
  if (!headers || !Array.isArray(headers)) return "";
  const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value || "";
}

/**
 * Busca e-mails não lidos no Gmail que ainda não foram processados pelo Sentinela.
 */
export async function fetchUnprocessedUnreadEmails(maxResults: number = 50): Promise<EmailMetadata[]> {
  const gmail = getGmailClient();
  if (!gmail) return [];

  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      logger.info("[EMAIL_SENTINEL] Nenhum e-mail não lido encontrado na caixa de entrada.");
      return [];
    }

    const messageIds = messages.map(m => m.id!).filter(Boolean);
    const alreadyProcessed = await areEmailsProcessed(messageIds);

    const newMessages = messages.filter(m => m.id && !alreadyProcessed.has(m.id));
    logger.info(`[EMAIL_SENTINEL] Encontrados ${messages.length} e-mails não lidos, sendo ${newMessages.length} novos para processamento.`);

    if (newMessages.length === 0) {
      return [];
    }

    // Carrega metadados dos novos e-mails em paralelo com limitação de concorrência
    const emails: EmailMetadata[] = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < newMessages.length; i += BATCH_SIZE) {
      const batch = newMessages.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (msg) => {
          try {
            const detailRes = await gmail.users.messages.get({
              userId: 'me',
              id: msg.id!,
              format: 'metadata',
              metadataHeaders: ['From', 'Subject', 'Date', 'To'],
            });

            const data = detailRes.data;
            const headers = data.payload?.headers;
            const fromRaw = getHeader(headers, 'From');
            const { fromName, fromEmail } = parseFromHeader(fromRaw);
            const subject = getHeader(headers, 'Subject') || "(sem assunto)";
            const date = getHeader(headers, 'Date');
            const to = getHeader(headers, 'To');
            const snippet = data.snippet || "";

            return {
              id: msg.id!,
              threadId: data.threadId || undefined,
              sender: fromRaw,
              fromName,
              fromEmail,
              to,
              subject,
              date,
              snippet,
            } as EmailMetadata;
          } catch (err: any) {
            logger.error(`[EMAIL_SENTINEL] Erro ao carregar metadados da mensagem ${msg.id}:`, err.message || err);
            return null;
          }
        })
      );

      for (const res of batchResults) {
        if (res) emails.push(res);
      }
    }

    return emails;
  } catch (err: any) {
    logger.error("[EMAIL_SENTINEL] Erro ao buscar e-mails no Gmail:", err.message || err);
    await handleGoogleAuthError(err);
    return [];
  }
}

/**
 * Carrega o corpo em texto simplificado de e-mails selecionados para a Etapa 2.
 */
export async function enrichEmailBody(email: EmailMetadata): Promise<EmailMetadata> {
  if (email.bodyText) return email;

  const gmail = getGmailClient();
  if (!gmail) {
    email.bodyText = email.snippet;
    return email;
  }

  try {
    const detailRes = await gmail.users.messages.get({
      userId: 'me',
      id: email.id,
      format: 'full',
    });

    const bodyText = extractTextFromBodyParts(detailRes.data.payload) || email.snippet;
    return {
      ...email,
      bodyText: bodyText.slice(0, 1500), // Limita para economizar tokens
    };
  } catch (err: any) {
    logger.warn(`[EMAIL_SENTINEL] Não foi possível carregar corpo completo de ${email.id}, usando snippet:`, err.message || err);
    return {
      ...email,
      bodyText: email.snippet,
    };
  }
}

function extractTextFromBodyParts(payload: any): string {
  if (!payload) return "";

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const text = extractTextFromBodyParts(part);
      if (text) return text;
    }
  }

  return "";
}
