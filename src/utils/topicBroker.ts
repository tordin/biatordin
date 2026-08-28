import { z } from "zod";
import { modelFlashStructured as model } from "../llm/model.js";
import { getRecentTopics, createTopic, updateTopicActivity } from "../memory/topics.js";
import { logger } from "./logger.js";
import { invokeStructuredWithFallback } from "./structuredOutput.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

const CLASSIFICATION_PROMPT = 
  "Você é o Classificador de Assuntos da Bia.\n" +
  "Sua função é analisar a nova mensagem e decidir se ela pertence ao assunto ativo, a um assunto recente, ou se inicia um novo.\n\n" +
  "Assunto Ativo Atual:\n" +
  "{currentTopic}\n\n" +
  "Outros Assuntos Recentes:\n" +
  "{recentTopics}\n\n" +
  "DIRETRIZES DE DECISÃO:\n" +
  "1. CONTINUAÇÃO DIRETA E REFINAMENTO: Se a nova mensagem responde, complementa, ajusta ou pede para buscar/refazer algo sobre a interação recente (ex: 'sim', 'ok', 'busca da memória, é pra vc ter mais coisas', 'procura de novo', 'tem mais coisas', 'complementando'), mantenha OBRIGATORIAMENTE o assunto ativo atual.\n" +
  "2. RETOMADA DE ASSUNTO ANTERIOR: Se o usuário se refere a algo do passado (ex: 'tenta de novo aquilo', 'e o piscineiro?', 'conseguiu?'), relacione ao assunto específico.\n" +
  "3. NOVO COMANDO INDEPENDENTE: Se for um tema inteiramente NOVO e sem nenhuma relação com o assunto ativo recente (ex: 'busque a cotação do dólar' enquanto estavam falando da festa de aniversário), aí sim é um novo assunto (topicId = 'new').\n" +
  "4. PEDIDOS DE MEMÓRIA E REVISÃO: Se a mensagem mencionar 'busca na memória', 'dá uma olhada de novo', 'tem mais informações', ou pedir para re-verificar o que a Bia anotou sobre o assunto que acabou de ser discutido, MANTENHA O TÓPICO ATIVO ATUAL. NUNCA crie um tópico novo para um pedido de revisão/busca do assunto recente.\n" +
  "5. SAUDAÇÃO APÓS INATIVIDADE: Se for saudação ('oi', 'bom dia', 'tudo bem?') e não houver conversa ativa recente, trate como novo assunto.\n" +
  "6. MENSAGENS CURTAS (1-2 PALAVRAS): Se não for um comando para um tema totalmente novo, mensagens curtas são continuação do assunto ativo.\n" +
  "7. Se for assunto novo (topicId = 'new'), forneça um newTitle curto (até 4 palavras) descrevendo o assunto.";

const classificationSchema = z.object({
  topicId: z.string().default("new").describe("O ID do assunto onde a mensagem se encaixa, ou 'new' para novo assunto"),
  newTitle: z.string().nullable().default(null).describe("Título curto (até 4 palavras) se for novo assunto"),
  reason: z.string().nullable().default(null).describe("Justificativa da decisão")
});

export async function resolveTopicForMessage(chatJid: string, messageText: string, accountName?: string): Promise<{ topicId: string, title: string }> {
  // 1. Obter os assuntos recentes
  const recent = await getRecentTopics(chatJid, 5);
  
  // 2. Se não houver assuntos recentes, criar um novo padrão "Conversa Geral"
  if (recent.length === 0) {
    logger.info(`[TOPIC BROKER] Nenhum assunto recente para ${chatJid}. Criando assunto padrão "Conversa Geral".`);
    const newTopic = await createTopic(chatJid, "Conversa Geral");
    return { topicId: newTopic.id, title: newTopic.title };
  }

  const currentTopic = recent[0];

  const recentListFormatted = recent.slice(1).map(t => `- ID: ${t.id}, Título: "${t.title}" (Última atividade: ${new Date(t.lastActive).toLocaleString()})`).join("\n");
  const currentTopicFormatted = `ID: ${currentTopic.id}, Título: "${currentTopic.title}" (Última atividade: ${new Date(currentTopic.lastActive).toLocaleString()})`;

  // 3. Chamar a LLM para decidir SEMPRE — sem código heurístico
  try {
    const formattedPrompt = CLASSIFICATION_PROMPT
      .replace("{currentTopic}", currentTopicFormatted)
      .replace("{recentTopics}", recentListFormatted || "(Nenhum outro assunto recente)");

    const response = await invokeStructuredWithFallback(
      model,
      classificationSchema,
      [
        new SystemMessage(formattedPrompt),
        new HumanMessage(`Nova Mensagem: "${messageText}"`)
      ],
      {
        name: "TopicClassification",
        metadata: { agentName: "topic_broker", threadId: chatJid }
      }
    );

    logger.info(`[TOPIC BROKER] Decisão: ${response.topicId} | Motivo: ${response.reason}`);

    if (response.topicId === "new" || !response.topicId) {
      const title = response.newTitle || "Novo Assunto";
      const newTopic = await createTopic(chatJid, title);
      return { topicId: newTopic.id, title: newTopic.title };
    }

    // Validar contra alucinação
    const matched = recent.find(t => t.id === response.topicId);
    if (matched) {
      await updateTopicActivity(matched.id);
      return { topicId: matched.id, title: matched.title };
    } else {
      logger.warn(`[TOPIC BROKER] ID inválido (${response.topicId}). Usando atual como fallback.`);
      await updateTopicActivity(currentTopic.id);
      return { topicId: currentTopic.id, title: currentTopic.title };
    }
  } catch (err) {
    logger.error("[TOPIC BROKER] Erro ao classificar, usando atual como fallback:", err);
    await updateTopicActivity(currentTopic.id);
    return { topicId: currentTopic.id, title: currentTopic.title };
  }
}
