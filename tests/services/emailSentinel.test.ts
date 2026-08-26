import { jest } from '@jest/globals';
import { applyHeuristicFilter } from "../../src/services/emailSentinel/heuristicFilter.js";
import { notifyImportantEmails, formatNotificationMessage } from "../../src/services/emailSentinel/notifier.js";
import { isGoogleAuthError, checkGoogleAuthStatus } from "../../src/services/emailSentinel/gmailFetcher.js";
import { EmailMetadata, EmailAnalysisResult } from "../../src/services/emailSentinel/types.js";
import { SentinelRule } from "../../src/memory/emailSentinel.js";

describe("Email Sentinel - 2-Stage Filter & Notification Services", () => {
  describe("Etapa 1: Filtro Heurístico e Metadados", () => {
    const sampleEmails: EmailMetadata[] = [
      {
        id: "msg_promo_1",
        sender: "newsletter@lojaexemplo.com",
        fromEmail: "newsletter@lojaexemplo.com",
        fromName: "Loja Exemplo",
        subject: "Super Desconto 50% OFF apenas hoje!",
        snippet: "Aproveite nossos cupons e descontos exclusivos.",
      },
      {
        id: "msg_2fa_2",
        sender: "security@servico.com",
        fromEmail: "security@servico.com",
        fromName: "Serviço Web",
        subject: "Seu código de verificação é 839201",
        snippet: "Use o código 839201 para concluir seu login.",
      },
      {
        id: "msg_work_3",
        sender: "cliente.marcos@empresa.com",
        fromEmail: "cliente.marcos@empresa.com",
        fromName: "Marcos Andrade",
        subject: "Aprovação do orçamento do projeto Bia",
        snippet: "Oi Luiz, analisamos a proposta e temos algumas dúvidas sobre o cronograma.",
      },
      {
        id: "msg_custom_ignore_4",
        sender: "contato@lojasubmarino.com",
        fromEmail: "contato@lojasubmarino.com",
        fromName: "Submarino",
        subject: "Novidades da semana",
        snippet: "Veja os lançamentos de tecnologia.",
      },
      {
        id: "msg_priority_5",
        sender: "secretaria@colegioprimeirospassos.com",
        fromEmail: "secretaria@colegioprimeirospassos.com",
        fromName: "Escola Cecília",
        subject: "Comunicado sobre a excursão escolar",
        snippet: "Prezados pais, solicitamos autorização assinada até sexta-feira.",
      },
    ];

    const customRules: SentinelRule[] = [
      {
        id: 1,
        type: "ignore",
        pattern: "submarino",
        target: "general",
        reason: "Descartar Submarino",
        createdAt: new Date().toISOString(),
      },
      {
        id: 2,
        type: "priority",
        pattern: "escola cecilia",
        target: "general",
        reason: "Prioridade alta para escola da filha",
        createdAt: new Date().toISOString(),
      },
    ];

    test("deve descartar e-mails promocionais, 2FA e regras de ignore, passando apenas e-mails legítimos e prioritários", async () => {
      const { passed, filtered } = await applyHeuristicFilter(sampleEmails, customRules);

      // Deve passar: msg_work_3 e msg_priority_5
      expect(passed.length).toBe(2);
      expect(passed.some(p => p.id === "msg_work_3")).toBe(true);
      expect(passed.some(p => p.id === "msg_priority_5")).toBe(true);

      const priorityEmail = passed.find(p => p.id === "msg_priority_5");
      expect(priorityEmail?.hasPriorityRule).toBe(true);
      expect(priorityEmail?.priorityReason).toContain("Prioridade alta");

      // Deve filtrar: msg_promo_1, msg_2fa_2, msg_custom_ignore_4
      expect(filtered.length).toBe(3);
      expect(filtered.some(f => f.email.id === "msg_promo_1")).toBe(true);
      expect(filtered.some(f => f.email.id === "msg_2fa_2")).toBe(true);
      expect(filtered.some(f => f.email.id === "msg_custom_ignore_4")).toBe(true);

      const submarinoFiltered = filtered.find(f => f.email.id === "msg_custom_ignore_4");
      expect(submarinoFiltered?.reason).toContain("Regra de descarte cadastrada");
    });
  });

  describe("Notificação Consolidada no WhatsApp", () => {
    test("deve formatar mensagem no WhatsApp com tom executivo e highlights quando houver e-mails importantes", () => {
      const importantEmails: EmailAnalysisResult[] = [
        {
          emailId: "msg_123",
          sender: "Diretoria do Condomínio",
          subject: "Convocação de Assembleia Extraordinária",
          priority: "HIGH",
          isImportant: true,
          summary: "Votação de reforma estrutural no sábado às 10h.",
          actionRequired: "Confirmar presença ou enviar procuração até sexta-feira.",
          reason: "Assunto urgente com impacto financeiro",
        },
        {
          emailId: "msg_456",
          sender: "Carlos Eduardo (Tech Lead)",
          subject: "Deploy da versão 2.0 e pendência de chave de API",
          priority: "MEDIUM",
          isImportant: true,
          summary: "O deploy está travado aguardando liberação de acesso.",
          actionRequired: "Autorizar chave de API no painel da AWS.",
          reason: "Bloqueio em entrega técnica",
        },
      ];

      const formatted = formatNotificationMessage(importantEmails);
      expect(formatted).not.toBeNull();
      expect(formatted).toContain("Oi Luiz!");
      expect(formatted).toContain("Diretoria do Condomínio");
      expect(formatted).toContain("Assembleia Extraordinária");
      expect(formatted).toContain("Confirmar presença");
      expect(formatted).toContain("Deploy da versão 2.0");
    });

    test("deve enviar notificação usando o notifier configurado quando houver e-mails importantes", async () => {
      const importantEmails: EmailAnalysisResult[] = [
        {
          emailId: "msg_123",
          sender: "Diretoria do Condomínio",
          subject: "Convocação de Assembleia Extraordinária",
          priority: "HIGH",
          isImportant: true,
          summary: "Votação de reforma estrutural no sábado às 10h.",
          actionRequired: "Confirmar presença ou enviar procuração até sexta-feira.",
          reason: "Assunto urgente com impacto financeiro",
        },
      ];

      let sentMessage = "";
      const customNotifier = async (text: string) => {
        sentMessage = text;
      };

      const result = await notifyImportantEmails(importantEmails, customNotifier);
      expect(result).toBe(true);
      expect(sentMessage).toContain("Oi Luiz!");
      expect(sentMessage).toContain("Diretoria do Condomínio");
    });

    test("deve retornar false e permanecer em silêncio absoluto se não houver e-mails importantes", async () => {
      let wasCalled = false;
      const customNotifier = async () => {
        wasCalled = true;
      };

      const result = await notifyImportantEmails([], customNotifier);
      expect(result).toBe(false);
      expect(wasCalled).toBe(false);

      const formattedNull = formatNotificationMessage([]);
      expect(formattedNull).toBeNull();
    });
  });

  describe("Detecção de Erros de Autenticação do Google (OAuth)", () => {
    test("deve identificar corretamente erros de token expirado ou revogado (invalid_grant)", () => {
      expect(isGoogleAuthError(new Error("invalid_grant: Token has been expired or revoked"))).toBe(true);
      expect(isGoogleAuthError(new Error("Could not refresh access token: 401 Unauthorized"))).toBe(true);
      expect(isGoogleAuthError({ code: 401, message: "Unauthorized" })).toBe(true);
      expect(isGoogleAuthError(new Error("ENOTFOUND network error"))).toBe(false);
      expect(isGoogleAuthError(null)).toBe(false);
    });

    test("deve verificar status de autenticação via checkGoogleAuthStatus", async () => {
      const status = await checkGoogleAuthStatus();
      expect(status).toBeDefined();
      expect(typeof status.configured).toBe("boolean");
      expect(typeof status.valid).toBe("boolean");
      expect(typeof status.message).toBe("string");
    });
  });
});
