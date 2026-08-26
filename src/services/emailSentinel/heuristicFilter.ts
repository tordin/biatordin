import { SentinelRule, getSentinelRules } from '../../memory/emailSentinel.js';
import { EmailMetadata, FilteredEmail } from './types.js';

// Padrões conhecidos de remetentes de ruído/automação/marketing
const DEFAULT_IGNORE_SENDER_PATTERNS = [
  'noreply',
  'no-reply',
  'mailer-daemon',
  'notifications@',
  'notification@',
  'newsletter@',
  'news@',
  'marketing@',
  'promocoes@',
  'updates@',
  'alerts@',
  'automated@',
  'system@',
  'digest-noreply@',
  'nao-responda@',
  'naoresponda@',
  'comunicacao@',
  'email-marketing',
];

// Padrões de assuntos que representam ruído descartável (ofertas, códigos temporários, recibos automáticos)
const DEFAULT_IGNORE_SUBJECT_PATTERNS = [
  'cupom',
  'desconto',
  'black friday',
  'liquidação',
  'liquidacao',
  'cashback',
  'oferta imperdível',
  'oferta exclusiva',
  'frete grátis',
  'frete gratis',
  'economize',
  'promoção',
  'promocao',
  'compre agora',
  'aproveite',
  '% off',
  'confirmação de login',
  'confirmacao de login',
  'código de segurança',
  'codigo de seguranca',
  'código de confirmação',
  'codigo de confirmacao',
  'código de verificação',
  'codigo de verificacao',
  'seu código',
  'seu codigo',
  'código de acesso',
  'codigo de acesso',
  'two-factor',
  '2fa',
  'tentativa de login',
  'novo acesso detectado',
  'alerta de segurança da conta',
  'termos de uso atualizados',
  'política de privacidade',
  'politica de privacidade',
];

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function matchesRule(email: EmailMetadata, rule: SentinelRule): boolean {
  const normPattern = normalizeText(rule.pattern);
  const normSender = normalizeText(email.sender);
  const normFromName = normalizeText(email.fromName || '');
  const normFromEmail = normalizeText(email.fromEmail || '');
  const normSubject = normalizeText(email.subject);
  const normSnippet = normalizeText(email.snippet);

  switch (rule.target) {
    case 'sender':
    case 'domain':
      return normSender.includes(normPattern) || normFromName.includes(normPattern) || normFromEmail.includes(normPattern);
    case 'subject':
      return normSubject.includes(normPattern);
    case 'general':
    default:
      return (
        normSender.includes(normPattern) ||
        normFromName.includes(normPattern) ||
        normFromEmail.includes(normPattern) ||
        normSubject.includes(normPattern) ||
        normSnippet.includes(normPattern)
      );
  }
}

/**
 * Executa a filtragem da Etapa 1 (Heurística e Metadados) sobre a lista de e-mails.
 * Separa os e-mails que devem ser descartados daqueles que exigem análise aprofundada na Etapa 2.
 */
export async function applyHeuristicFilter(
  emails: EmailMetadata[],
  customRules?: SentinelRule[]
): Promise<{ passed: EmailMetadata[]; filtered: FilteredEmail[] }> {
  const rules = customRules || (await getSentinelRules());
  const priorityRules = rules.filter(r => r.type === 'priority');
  const ignoreRules = rules.filter(r => r.type === 'ignore');

  const passed: EmailMetadata[] = [];
  const filtered: FilteredEmail[] = [];

  for (const email of emails) {
    // 1. Verifica se bate em alguma regra de PRIORIDADE explícita do usuário
    const matchedPriority = priorityRules.find(r => matchesRule(email, r));
    if (matchedPriority) {
      passed.push({
        ...email,
        hasPriorityRule: true,
        priorityReason: matchedPriority.reason || matchedPriority.pattern,
      });
      continue;
    }

    // 2. Verifica se bate em alguma regra de IGNORE explícita do usuário
    const matchedIgnore = ignoreRules.find(r => matchesRule(email, r));
    if (matchedIgnore) {
      filtered.push({
        email,
        passed: false,
        reason: `Regra de descarte cadastrada: "${matchedIgnore.pattern}"`,
        ruleMatched: matchedIgnore,
      });
      continue;
    }

    // 3. Verifica heurística de remetente automatizado / newsletter padrão
    const normSender = normalizeText(email.sender);
    const normFromEmail = normalizeText(email.fromEmail || '');
    const isAutoSender = DEFAULT_IGNORE_SENDER_PATTERNS.some(
      p => normSender.includes(p) || normFromEmail.includes(p)
    );

    if (isAutoSender) {
      filtered.push({
        email,
        passed: false,
        reason: 'Remetente identificado como notificação automática / newsletter padrão',
      });
      continue;
    }

    // 4. Verifica heurística de assunto promocional / 2FA padrão
    const normSubject = normalizeText(email.subject);
    const isPromoOr2FA = DEFAULT_IGNORE_SUBJECT_PATTERNS.some(
      p => normSubject.includes(p)
    );

    if (isPromoOr2FA) {
      filtered.push({
        email,
        passed: false,
        reason: 'Assunto classificado como promocional, código de acesso ou alerta automático descartável',
      });
      continue;
    }

    // 5. Verifica se o snippet contém links claros de descadastro (unsubscribe)
    const normSnippet = normalizeText(email.snippet);
    if (normSnippet.includes('descadastre-se') || normSnippet.includes('unsubscribe') || normSnippet.includes('opt out')) {
      filtered.push({
        email,
        passed: false,
        reason: 'Conteúdo contém links de descadastramento de lista de marketing (unsubscribe)',
      });
      continue;
    }

    // Passou por todas as heurísticas -> Candidato à análise da Etapa 2
    passed.push(email);
  }

  return { passed, filtered };
}
