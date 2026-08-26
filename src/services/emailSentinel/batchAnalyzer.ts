import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { modelFlashStructured } from '../../llm/model.js';
import { invokeStructuredWithFallback } from '../../utils/structuredOutput.js';
import { logger } from '../../utils/logger.js';
import { EmailMetadata, EmailAnalysisResult } from './types.js';
import { enrichEmailBody } from './gmailFetcher.js';

const batchAnalysisSchema = z.object({
  analysis: z.array(
    z.object({
      emailId: z.string().describe("ID exato do e-mail analisado"),
      sender: z.string().describe("Nome ou remetente identificado do e-mail"),
      subject: z.string().describe("Assunto do e-mail"),
      priority: z.enum(["HIGH", "MEDIUM", "LOW"]).describe("Classificação de prioridade"),
      isImportant: z.boolean().describe("True se exige decisão, ação ou atenção do Luiz, ou se tem relevância real (pessoal/profissional/financeira). False se for ruído, recibo rotineiro ou informativo irrelevante."),
      summary: z.string().describe("Resumo executivo de 1 a 2 frases do que se trata"),
      actionRequired: z.string().describe("Ação prática ou decisão requerida do Luiz (ex: 'Aprovar proposta', 'Pagar boleto até 25/08', 'Confirmar presença na reunião', 'Apenas ciência')"),
      reason: z.string().describe("Motivo da classificação de prioridade"),
    })
  ).describe("Lista de análises individuais para cada e-mail do lote"),
});

const BATCH_ANALYZER_SYSTEM_PROMPT =
  "Você é o Analista Executivo do Sentinela de E-mails da Bia.\n" +
  "Sua função é avaliar um LOTE de e-mails pré-filtrados do Luiz e identificar SOMENTE o que realmente importa e exige atenção ou decisão humana.\n\n" +
  "CRITÉRIOS DE PRIORIDADE:\n" +
  "- HIGH (Alta): E-mails com urgência real, cobranças com prazo, reuniões importantes, mensagens pessoais diretas de pessoas conhecidas, problemas em projetos, avisos da escola ou condomínio marcados como prioridade.\n" +
  "- MEDIUM (Média): Atualizações relevantes de projetos, propostas comerciais em andamento, comunicados que exigem leitura atenta mas sem urgência imediata.\n" +
  "- LOW (Baixa/Descartável): Recibos automáticos, confirmações de envio de encomendas comuns, informativos genéricos sem ação necessária.\n\n" +
  "DIRETRIZES DE SAÍDA:\n" +
  "- Marque `isImportant = true` para e-mails de prioridade HIGH ou MEDIUM que justifiquem alertar o Luiz no WhatsApp.\n" +
  "- Seja objetivo, conciso e claro no resumo e na ação requerida.";

/**
 * Analisa uma lista de e-mails em lote através de uma ÚNICA chamada de LLM.
 */
export async function analyzeEmailBatchWithLLM(
  emails: EmailMetadata[]
): Promise<EmailAnalysisResult[]> {
  if (emails.length === 0) {
    return [];
  }

  logger.info(`[EMAIL_SENTINEL] Iniciando análise em lote de ${emails.length} e-mails via LLM...`);

  // Enriquecer e-mails com corpo de texto (com snippet como fallback)
  const enrichedEmails = await Promise.all(
    emails.map(email => enrichEmailBody(email))
  );

  const formattedEmailsText = enrichedEmails.map((email, idx) => {
    return (
      `=== E-MAIL ${idx + 1} ===\n` +
      `ID: ${email.id}\n` +
      `De: ${email.sender}\n` +
      `Para: ${email.to || "Luiz"}\n` +
      `Data: ${email.date || "recente"}\n` +
      `Assunto: ${email.subject}\n` +
      `Regra de Prioridade do Usuário: ${email.hasPriorityRule ? `SIM (${email.priorityReason})` : "NÃO"}\n` +
      `Conteúdo / Trecho:\n${email.bodyText || email.snippet}\n`
    );
  }).join("\n\n");

  const messages = [
    new SystemMessage(BATCH_ANALYZER_SYSTEM_PROMPT),
    new HumanMessage(
      `Por favor, analise os seguintes ${enrichedEmails.length} e-mails em lote e retorne a classificação estruturada:\n\n${formattedEmailsText}`
    ),
  ];

  try {
    const result = await invokeStructuredWithFallback(
      modelFlashStructured,
      batchAnalysisSchema,
      messages,
      {
        name: "BatchEmailAnalysis",
        metadata: { batchSize: enrichedEmails.length, agentName: "emailSentinel" },
      }
    );

    const analyzedList = result.analysis || [];
    logger.info(`[EMAIL_SENTINEL] Análise em lote concluída. ${analyzedList.filter(a => a.isImportant).length} e-mails classificados como importantes de ${analyzedList.length} analisados.`);

    return analyzedList.map((item) => ({
      emailId: item.emailId,
      sender: item.sender,
      subject: item.subject,
      priority: item.priority,
      isImportant: item.isImportant,
      summary: item.summary,
      actionRequired: item.actionRequired,
      reason: item.reason,
    }));
  } catch (err: any) {
    logger.error("[EMAIL_SENTINEL] Erro na análise estruturada de e-mails em lote:", err.message || err);
    
    // Fallback gracioso: Se o LLM falhar, trata e-mails com regra explícita de prioridade como importantes
    return enrichedEmails.map((email) => {
      const isPriority = !!email.hasPriorityRule;
      return {
        emailId: email.id,
        sender: email.fromName || email.sender,
        subject: email.subject,
        priority: isPriority ? 'HIGH' : 'MEDIUM',
        isImportant: isPriority,
        summary: email.snippet.slice(0, 150),
        actionRequired: isPriority ? "Verificar mensagem de remetente prioritário" : "Avaliação pendente",
        reason: isPriority ? `Regra de prioridade ativa (${email.priorityReason})` : "Análise em modo de contingência",
      };
    });
  }
}
