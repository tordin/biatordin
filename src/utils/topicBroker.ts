import { z } from "zod";
import { modelFlash as model } from "../llm/model.js";
import { getRecentTopics, createTopic, updateTopicActivity } from "../memory/topics.js";
import { getChatHistory } from "../memory/chatHistory.js";
import { logger } from "./logger.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

const CLASSIFICATION_PROMPT = 
  "Você é o Classificador de Assuntos da Bia.\n" +
  "O usuário enviou uma ou mais mensagens em um chat do WhatsApp.\n" +
  "Sua tarefa é analisar a nova mensagem e decidir se ela pertence ao assunto ativo atual, a um dos assuntos recentes, ou se inicia um novo assunto.\n\n" +
  "Assunto Ativo Atual (último com atividade):\n" +
  "{currentTopic}\n\n" +
  "Outros Assuntos Recentes no Chat:\n" +
  "{recentTopics}\n\n" +
  "Regras de Decisão:\n" +
  "1. Se a nova mensagem for uma continuação DIRETA do 'Assunto Ativo Atual', retorne o ID desse assunto.\n" +
  "2. Se a mensagem fizer referência a algo do passado (ex: 'tenta de novo', 'conseguiu aquilo?', 'cancela aquilo') que se encaixa melhor em um dos 'Outros Assuntos Recentes', retorne o ID desse assunto específico.\n" +
  "3. CUIDADO COM FALSOS POSITIVOS: Uma mensagem não pertence a um assunto antigo apenas porque compartilha palavras-chave (ex: 'tarefas', 'lista'). Só relacione a um assunto antigo se o usuário pedir explicitamente para RETOMAR ou MODIFICAR aquele fluxo específico (ex: 'tenta de novo aquilo'). Se a mensagem for um NOVO comando direto (ex: 'liste minhas tarefas', 'anote isso', 'busque tal coisa'), retorne topicId = 'new'.\n" +
  "4. Se a nova mensagem for APENAS uma saudação isolada ou conversa fiada ('oi', 'tudo bem?', 'obrigado') e já se passaram vários minutos desde a última atividade, retorne topicId = 'new'. Isso é essencial para 'limpar' o histórico e não arrastar o contexto de tarefas antigas.\n" +
  "5. Se a mensagem introduzir um assunto claramente diferente dos listados, retorne topicId = 'new'.\n" +
  "6. Quando retornar topicId = 'new', forneça um newTitle curto (até 4 palavras).";

// Palavras de ação que indicam claramente um novo comando (devem sempre ir para o LLM)
const COMMAND_VERBS = /\b(lista|liste|listar|busca|busque|buscar|cria|crie|criar|agenda|agende|agendar|anota|anote|anotar|mostra|mostre|mostrar|lembra|lembre|lembrar|procura|procure|procurar|acha|ache|achar|explica|explique|explicar|faz|faça|fazer|manda|mande|mandar|envia|envie|enviar|adiciona|adicione|adicionar|remove|remova|remover|deleta|delete|deletar|limpa|limpe|limpar|conta|conte|contar|calcula|calcule|calcular|traduz|traduza|traduzir|pesquisa|pesquise|pesquisar|analisa|analise|analisar|compara|compare|comparar|resume|resuma|resumir|corrige|corrija|corrigir|reescreve|reescreva|reescrever|descreve|descreva|descrever|define|defina|definir|cancela|cancele|cancelar|sugere|sugira|sugerir|recomenda|recomende|recomendar|lembrete|lembretes)\b/i;

// Palavras de continuação: mensagens de 1-2 palavras que claramente são respostas/confirmações
const CONTINUATION_WORDS = new Set([
  "sim", "não", "nao", "ok", "okay", "blz", "beleza", "entendi",
  "ah", "ahn", "hmm", "hum", "hmmm", "aff", "puts", "nossa", "caramba",
  "sim sim", "pode ser", "verdade", "certo", "show", "legal", "top",
  "maravilha", "perfeito", "ótimo", "otimo", "exato", "isso", "concordo",
  "então", "entao", "daí", "dai", "então tá", "entao ta",
  "vou ver", "vamos ver", "deixa quieto", "deixa pra lá", "deixa pra la",
  "relaxa", "tranquilo", "de boa", "sem problema", "pode deixar", "fechou",
  "é", "eh", "e", "ta", "tá", "tb", "também", "tambem",
  "obrigado", "obrigada", "valeu", "vlw", "brigado", "brigada",
  "tchau", "flw", "falou", "ate mais", "até mais", "ate logo", "até logo",
  "boa", "boa noite", "bom dia", "boa tarde", "oi", "ola", "olá",
  "tudo bem", "tudo bem?", "tudo bom", "tudo bom?", "opa"
]);

// Saudações que, se isoladas após longa inatividade, podem iniciar um novo assunto
const STANDALONE_GREETINGS = new Set([
  "oi", "ola", "olá", "bom dia", "boa tarde", "boa noite",
  "tudo bem", "tudo bem?", "tudo bom", "tudo bom?", "opa", "tchau"
]);

export async function resolveTopicForMessage(chatJid: string, messageText: string, accountName?: string): Promise<{ topicId: string, title: string }> {
  // 1. Obter os assuntos recentes
  const recent = await getRecentTopics(chatJid, 5);
  
  // Se não houver assuntos recentes, criar um novo padrão "Conversa Geral"
  if (recent.length === 0) {
    logger.info(`[TOPIC BROKER] Nenhum assunto recente para ${chatJid}. Criando assunto padrão "Conversa Geral".`);
    const newTopic = await createTopic(chatJid, "Conversa Geral");
    return { topicId: newTopic.id, title: newTopic.title };
  }

  const currentTopic = recent[0];
  const timeSinceLastActive = Date.now() - currentTopic.lastActive;
  const isVeryRecent = timeSinceLastActive < 3 * 60 * 1000; // 3 minutos

  // Heurística 0: Se a última mensagem no chat foi da Bia (menos de 5 min atrás),
  // a resposta do usuário é obviamente continuação do assunto atual.
  if (accountName && isVeryRecent) {
    const chatHistory = getChatHistory(accountName, chatJid, 3);
    const lastHistoryMsg = chatHistory[chatHistory.length - 1];
    if (lastHistoryMsg && lastHistoryMsg.isFromMe &&
        (Date.now() - lastHistoryMsg.timestamp) < 5 * 60 * 1000) {
      logger.info(`[TOPIC BROKER] Última mensagem foi da Bia há ${Math.round((Date.now() - lastHistoryMsg.timestamp) / 1000)}s. Resposta é continuação automática do assunto: "${currentTopic.title}"`);
      await updateTopicActivity(currentTopic.id);
      return { topicId: currentTopic.id, title: currentTopic.title };
    }
  }

  // Heurística rápida para economizar LLM em mensagens muito curtas ou típicas
  const cleanMsg = messageText.trim().toLowerCase();

  // Palavras de continuação: sempre mantêm o assunto atual, mesmo após inatividade
  if (CONTINUATION_WORDS.has(cleanMsg)) {
    // Saudações standalone após longa inatividade → novo tópico para limpar contexto
    if (STANDALONE_GREETINGS.has(cleanMsg) && !isVeryRecent) {
      logger.info(`[TOPIC BROKER] Saudação isolada após inatividade (> 3 min). Criando novo tópico para limpar contexto.`);
      const newTopic = await createTopic(chatJid, "Saudação");
      return { topicId: newTopic.id, title: newTopic.title };
    }
    logger.info(`[TOPIC BROKER] Palavra de continuação detectada: "${cleanMsg}". Mantendo no assunto atual: "${currentTopic.title}"`);
    await updateTopicActivity(currentTopic.id);
    return { topicId: currentTopic.id, title: currentTopic.title };
  }

  // Heurística de contagem de palavras: mensagens de 1-2 palavras sem verbo de comando
  // provavelmente são continuação, não um novo assunto.
  const words = cleanMsg.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const hasCommandVerb = COMMAND_VERBS.test(cleanMsg);

  if (wordCount <= 2 && !hasCommandVerb) {
    logger.info(`[TOPIC BROKER] Mensagem curta (${wordCount} palavra(s)) sem verbo de comando. Mantendo no assunto atual: "${currentTopic.title}"`);
    await updateTopicActivity(currentTopic.id);
    return { topicId: currentTopic.id, title: currentTopic.title };
  }

  const recentListFormatted = recent.slice(1).map(t => `- ID: ${t.id}, Título: "${t.title}" (Última atividade: ${new Date(t.lastActive).toLocaleString()})`).join("\n");
  const currentTopicFormatted = `ID: ${currentTopic.id}, Título: "${currentTopic.title}" (Última atividade: ${new Date(currentTopic.lastActive).toLocaleString()})`;

  const classificationModel = model.withStructuredOutput(z.object({
    topicId: z.string().describe("O ID do assunto existente onde a mensagem se encaixa, ou 'new' se for um assunto novo."),
    newTitle: z.string().optional().describe("Um título curto e claro para o assunto caso topicId seja 'new'."),
    reason: z.string().describe("Justificativa para a decisão.")
  }), { name: "TopicClassification" });

  try {
    const formattedPrompt = CLASSIFICATION_PROMPT
      .replace("{currentTopic}", currentTopicFormatted)
      .replace("{recentTopics}", recentListFormatted || "(Nenhum outro assunto recente)");

    const response = await classificationModel.invoke([
      new SystemMessage(formattedPrompt),
      new HumanMessage(`Nova Mensagem: "${messageText}"`)
    ], {
      metadata: { agentName: "topic_broker", threadId: chatJid }
    });

    logger.info(`[TOPIC BROKER] Decisão: ${response.topicId} | Motivo: ${response.reason}`);

    if (response.topicId === "new" || !response.topicId) {
      const title = response.newTitle || "Novo Assunto";
      const newTopic = await createTopic(chatJid, title);
      return { topicId: newTopic.id, title: newTopic.title };
    }

    // Validar se o ID retornado realmente existe na lista recente para evitar alucinação
    const matched = recent.find(t => t.id === response.topicId);
    if (matched) {
      await updateTopicActivity(matched.id);
      return { topicId: matched.id, title: matched.title };
    } else {
      // Se alucinou um ID inválido, usa o atual
      logger.warn(`[TOPIC BROKER] ID retornado inválido (${response.topicId}). Usando o atual como fallback.`);
      await updateTopicActivity(currentTopic.id);
      return { topicId: currentTopic.id, title: currentTopic.title };
    }
  } catch (err) {
    logger.error("[TOPIC BROKER] Erro ao classificar assunto, usando assunto atual como fallback:", err);
    await updateTopicActivity(currentTopic.id);
    return { topicId: currentTopic.id, title: currentTopic.title };
  }
}

