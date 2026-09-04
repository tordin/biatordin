import { z } from "zod";
import { modelFlashStructured as model } from "../llm/model.js";
import { getRecentTopics, createTopic, updateTopicActivity } from "../memory/topics.js";
import { logger } from "./logger.js";
import { invokeStructuredWithFallback } from "./structuredOutput.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

const CLASSIFICATION_PROMPT = 
  "Você é o Classificador de Assuntos da Bia.\n" +
  "Sua função é analisar a nova mensagem e decidir se ela pertence ao assunto ativo, a um assunto recente, ou se inicia um novo. Você também deve decidir se a intenção é atômica ou complexa.\n\n" +
  "Assunto Ativo Atual:\n" +
  "{currentTopic}\n\n" +
  "Outros Assuntos Recentes:\n" +
  "{recentTopics}\n\n" +
  "DIRETRIZES DE DECISÃO:\n" +
  "1. CONTINUAÇÃO DIRETA E REFINAMENTO: Se a nova mensagem responde, complementa, ajusta ou pede para buscar/refazer algo sobre a interação recente, mantenha OBRIGATORIAMENTE o assunto ativo atual.\n" +
  "2. RETOMADA DE ASSUNTO ANTERIOR: Se o usuário se refere a algo do passado, relacione ao assunto específico.\n" +
  "3. NOVO COMANDO INDEPENDENTE: Se for um tema inteiramente NOVO, crie um novo assunto (topicId = 'new').\n" +
  "4. PEDIDOS DE MEMÓRIA E REVISÃO: MANTENHA O TÓPICO ATIVO ATUAL. NUNCA crie um tópico novo para um pedido de revisão/busca do assunto recente.\n" +
  "5. SAUDAÇÃO APÓS INATIVIDADE: Trate como novo assunto.\n" +
  "6. MENSAGENS CURTAS (1-2 PALAVRAS): São continuação do assunto ativo.\n" +
  "7. Se for assunto novo, forneça um newTitle curto (até 4 palavras).\n" +
  "8. ROUTING: Identifique se o pedido é uma intenção atômica/simples (ex: 'salve isso', 'crie uma tarefa', 'resuma') e roteie para 'supervisor'. Se for uma intenção ambígua ou complexa que exija planejamento de múltiplos passos (ex: 'pesquise sobre X e me mande um email', 'organize minha semana e crie tarefas'), roteie para 'architect'.";

const classificationSchema = z.object({
  topicId: z.string().default("new").describe("O ID do assunto onde a mensagem se encaixa, ou 'new' para novo assunto"),
  newTitle: z.string().nullable().default(null).describe("Título curto (até 4 palavras) se for novo assunto"),
  route: z.enum(["supervisor", "architect"]).default("supervisor").describe("'supervisor' para intenções atômicas. 'architect' para intenções complexas."),
  reason: z.string().nullable().default(null).describe("Justificativa da decisão")
});

export async function resolveTopicForMessage(chatJid: string, messageText: string, accountName?: string): Promise<{ topicId: string, title: string, route: string }> {
  const recent = await getRecentTopics(chatJid, 5);
  
  if (recent.length === 0) {
    logger.info(`[TOPIC BROKER] Nenhum assunto recente para ${chatJid}. Criando assunto padrão "Conversa Geral".`);
    const newTopic = await createTopic(chatJid, "Conversa Geral");
    return { topicId: newTopic.id, title: newTopic.title, route: "supervisor" };
  }

  const currentTopic = recent[0];

  const recentListFormatted = recent.slice(1).map(t => `- ID: ${t.id}, Título: "${t.title}" (Última atividade: ${new Date(t.lastActive).toLocaleString()})`).join("\n");
  const currentTopicFormatted = `ID: ${currentTopic.id}, Título: "${currentTopic.title}" (Última atividade: ${new Date(currentTopic.lastActive).toLocaleString()})`;

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

    logger.info(`[TOPIC BROKER] Decisão: ${response.topicId} | Rota: ${response.route} | Motivo: ${response.reason}`);
    
    let finalTopicId = response.topicId;
    let finalTitle = "";

    if (response.topicId === "new" || !response.topicId) {
      const title = response.newTitle || "Novo Assunto";
      const newTopic = await createTopic(chatJid, title);
      finalTopicId = newTopic.id;
      finalTitle = newTopic.title;
    } else {
      const matched = recent.find(t => t.id === response.topicId);
      if (matched) {
        await updateTopicActivity(matched.id);
        finalTopicId = matched.id;
        finalTitle = matched.title;
      } else {
        logger.warn(`[TOPIC BROKER] ID inválido (${response.topicId}). Usando atual como fallback.`);
        await updateTopicActivity(currentTopic.id);
        finalTopicId = currentTopic.id;
        finalTitle = currentTopic.title;
      }
    }
    
    return { topicId: finalTopicId, title: finalTitle, route: response.route };
  } catch (err) {
    logger.error("[TOPIC BROKER] Erro ao classificar, usando atual como fallback:", err);
    await updateTopicActivity(currentTopic.id);
    return { topicId: currentTopic.id, title: currentTopic.title, route: "supervisor" };
  }
}
