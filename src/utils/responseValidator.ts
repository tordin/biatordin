import { logger } from "./logger.js";

/**
 * Maps common claim patterns in Portuguese to the agents that MUST be in
 * the executionLog for the claim to be valid.
 */
const CLAIM_AGENT_MAP: Array<{ pattern: RegExp; requiredAgents: string[]; claimDescription: string }> = [
  {
    pattern: /(?:mandei|enviei|falei|respondi|escrevi)\s+(?:a\s+)?(?:mensagem|msg|pro |pra |para )/i,
    requiredAgents: ["missionAgent"],
    claimDescription: "envio de mensagem",
  },
  {
    pattern: /(?:j[áa]\s+)?(?:pesquisei|busquei|procurei)(?:\s+(?:na\s+)?(?:web|internet|google))?/i,
    requiredAgents: ["searchAgent"],
    claimDescription: "busca na web",
  },
  {
    pattern: /(?:consultei|verifiquei|olhei|chequei)\s+(?:a\s+)?(?:sua\s+)?(?:agenda|calend[áa]rio|compromisso|reuni[ãa]o|evento)/i,
    requiredAgents: ["calendarAgent"],
    claimDescription: "consulta à agenda",
  },
  {
    pattern: /(?:verifiquei|li|olhei|chequei|consultei)\s+(?:os?\s+)?(?:seus?\s+)?(?:e-?mails?|gmail|caixa de entrada)/i,
    requiredAgents: ["gmailAgent"],
    claimDescription: "consulta a e-mails",
  },
  {
    pattern: /(?:li|abri|resumi|analisei)\s+(?:o\s+)?(?:documento|doc|arquivo|planilha)/i,
    requiredAgents: ["docsAgent", "driveAgent"],
    claimDescription: "leitura de documento",
  },
  {
    pattern: /(?:pesquisei|busquei|encontrei)\s+(?:o[s]?\s+)?(?:pre[çc]os?|produtos?|ofertas?|loja)/i,
    requiredAgents: ["shoppingAgent", "searchAgent"],
    claimDescription: "busca de produtos/preços",
  },
  {
    pattern: /(?:verifiquei|consultei|li|puxei|chequei)\s+(?:as?\s+)?(?:mensagens?|conversas?|hist[óo]rico)\s+(?:do|da|no|na)/i,
    requiredAgents: ["whatsappAgent"],
    claimDescription: "consulta a mensagens do WhatsApp",
  },
];

export interface ValidationResult {
  isValid: boolean;
  violations: string[];
  correctedResponse?: string;
}

/**
 * Validates that the supervisor's response text is consistent with
 * the tools/agents that were actually executed during this turn.
 * 
 * Uses deterministic regex matching — no LLM call needed.
 */
export function validateResponseConsistency(
  response: string,
  executionLog: string[],
): ValidationResult {
  const violations: string[] = [];
  let correctedResponse = response;

  if (!response || response.toUpperCase() === "[SILENT]") {
    return { isValid: true, violations: [] };
  }

  for (const claim of CLAIM_AGENT_MAP) {
    if (claim.pattern.test(response)) {
      // Check if at least one of the required agents was actually executed
      const wasExecuted = claim.requiredAgents.some(agent => executionLog.includes(agent));
      
      if (!wasExecuted) {
        violations.push(
          `A resposta afirma ter feito "${claim.claimDescription}" mas nenhum dos agentes necessários ` +
          `(${claim.requiredAgents.join(", ")}) foi executado neste turno. ` +
          `executionLog atual: [${executionLog.join(", ")}]`
        );
      }
    }
  }

  if (violations.length > 0) {
    logger.warn(
      `[RESPONSE_VALIDATOR] ${violations.length} violação(ões) detectada(s):\n` +
      violations.map((v, i) => `  ${i + 1}. ${v}`).join("\n")
    );

    // Strip false claims from the response
    for (const claim of CLAIM_AGENT_MAP) {
      const wasExecuted = claim.requiredAgents.some(agent => executionLog.includes(agent));
      if (!wasExecuted && claim.pattern.test(correctedResponse)) {
        // Replace the false claim with an honest admission
        correctedResponse = correctedResponse.replace(
          claim.pattern,
          "não consegui completar a ação de " + claim.claimDescription
        );
      }
    }
  }

  return {
    isValid: violations.length === 0,
    violations,
    correctedResponse: violations.length > 0 ? correctedResponse : undefined,
  };
}
