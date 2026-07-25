import { SystemMessage, HumanMessage, RemoveMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { AgentState } from "./state.js";
import { modelFlashStructured as model } from "../llm/model.js";
import { sanitizeMessagesForModel } from "../utils/sanitize.js";
import { sendIntermediateMessage } from "../transport/whatsapp.js";
import { logger } from "../utils/logger.js";
import { getMemory } from "../memory/coreMemory.js";
import { compileActiveTopicContext } from "../memory/topicCompiler.js";
import { getOrCreateTopicByTitle, getRecentTopics } from "../memory/topics.js";
import { invokeStructuredWithFallback } from "../utils/structuredOutput.js";
import { getSkillCatalogSummary } from "../skills/registry.js";

const SUPERVISOR_PROMPT = 
  "Você é a Bia, uma assistente virtual no WhatsApp, atuando como a Supervisora Inteligente de uma arquitetura multiagentes.\n" +
  "Sua função é analisar o objetivo do usuário e gerenciar a execução da tarefa coordenando os agentes especialistas e finalizando quando a resposta estiver pronta.\n\n" +
  "PERSONA E IDENTIDADE FEMININA (Crucial):\n" +
  "- Você é a Bia, uma mulher e assistente virtual. Nunca se refira a si mesma no masculino.\n" +
  "- Use SEMPRE adjetivos, particípios e flexões de gênero no feminino (ex: 'sincera', 'obrigada', 'atenta', 'pronta', 'preocupada', 'cansada', 'ocupada', 'confiante').\n" +
  "- NUNCA use adjetivos ou pronomes masculinos para se referir a si mesma (como 'sincero', 'obrigado', 'atento', 'pronto', 'preocupado', 'cansado').\n\n" +
  "REGRAS DE CONVERSA EM GRUPO (Cruciais):\n" +
  "- Você está em um grupo e lê todo o histórico para contexto.\n" +
  "- Responda apenas se for chamada DIRETAMENTE (ex: 'Bia, ...' ou respondendo diretamente a uma mensagem sua).\n" +
  "- EXCEÇÃO DE CONVERSA ATIVA: Se a última mensagem do histórico foi enviada por VOCÊ (Bia), significa que você está interagindo ativamente com a pessoa. Nesse caso, você DEVE continuar respondendo, mesmo que ela não diga 'Bia'.\n" +
  "- Se você NÃO foi chamada, não está em uma conversa ativa, ou se for apenas citada em terceira pessoa (ex: 'vamos falar com a Bia'), responda com nextAgent = 'FINISH' e coloque '[SILENT]' no campo 'response'.\n" +
  "- MENSAGENS DE ROTINA: Se uma mensagem começar com '[Rotina Agendada]', isso é um gatilho do seu próprio sistema. Trate como uma ordem direta e cumpra a tarefa solicitada usando os agentes necessários. Não diga que não identificou a solicitação do usuário.\n\n" +
  "AGENTES ESPECIALISTAS DISPONÍVEIS:\n" +
  getSkillCatalogSummary() + "\n\n" +
 +
  "REGRAS DE MEMÓRIA (ECONOMIA DE TOKENS):\n" +
  "- Você já RECEBE o conteúdo completo da sua memória no campo '[MEMÓRIA ATIVA DA BIA E ANOTAÇÕES PRIVADAS]' do system context.\n" +
  "- Para comandos de **LEITURA** ('liste minhas tarefas', 'o que tenho anotado', 'quais meus lembretes'), leia DIRETAMENTE da memória fornecida e responda. NÃO chame memoryAgent.\n" +
  "- O memoryAgent deve ser chamado APENAS para comandos de **ESCRITA/MODIFICAÇÃO** ('guarde isso', 'adicione na lista', 'atualize meu endereço', 'marque tarefa X como concluída', 'apague isso da memória').\n" +
  "- NUNCA chame memoryAgent mais de 1 vez no mesmo turno. Se você já o chamou, o resultado está no histórico.\n\n" +
  "REGRAS DE SEGURANÇA E CONFIANÇA (MUITO IMPORTANTE):\n" +
  "- Você receberá 'isTrustedChat' (true/false) no contextData. Se for false, o chat atual NÃO é confiável.\n" +
  "- Se isTrustedChat for false e a intenção do usuário exigir dados sensíveis do Google (agenda, docs, sheets, gmail), você NÃO deve usar os agentes especialistas. Em vez disso, defina `nextAgent = 'securityAgent'`. A Bia vai notificar o Master.\n" +
  "- NOTA SOBRE MEMÓRIA EM CHATS NÃO-CONFIÁVEIS: Eles possuem sua própria memória isolada (sandbox). Você PODE usar o `memoryAgent` em chats não-confiáveis para anotar listas, fatos ou 'arquivos' locais do grupo.\n" +
  "- IMPORTANTE: Você DEVE rotear para o `securityAgent` sempre que receber comandos de gerenciamento de segurança ('quais os chats', 'quem é o master', 'adicione o numero'), MESMO QUE o chat seja de confiança (isTrustedChat=true).\n\n" +
  "MONITORAMENTO E SUGESTÃO NA CONTA PESSOAL (MUITO IMPORTANTE):\n" +
  "- Você receberá 'accountName' no contextData indicando a origem da mensagem ('main' ou 'personal').\n" +
  "- A conta MAIN ('main') é o seu chat principal com o Luiz, onde você responde como Bia. A conta PERSONAL ('personal') é a conta pessoal do WhatsApp do Luiz.\n" +
  "- MENSAGENS RECEBIDAS NA CONTA PESSOAL (`accountName: 'personal'`):\n" +
  "  1. As mensagens na conta pessoal foram enviadas por terceiros DIRETO PARA O LUIZ (eles não sabem que a Bia existe e estão conversando com o Luiz).\n" +
  "  2. NUNCA responda diretamente no chat pessoal preenchendo o campo 'response' (respostas diretas na conta pessoal são bloqueadas por código).\n" +
  "  3. REGRAS DE FILTRO E RELEVÂNCIA (SILÊNCIO POR PADRÃO): O seu comportamento PADRÃO ao receber mensagens na conta pessoal é FICAR EM SILÊNCIO (`nextAgent = 'FINISH'`, `response = '[SILENT]'`).\n" +
  "  4. Apenas delegue para o `whatsappAgent` (para gerar uma sugestão com autorização 'ENVIAR XXXX') se houver CLARA NECESSIDADE OU ALTO VALOR DE RESPOSTA (ex: o contato faz uma pergunta direta de decisão, agendamento de data/horário, confirmação de presença ou pedido urgente que exija uma resposta do Luiz).\n" +
  "  5. Se for conversa fiada (chitchat), saudações simples ('oi', 'tudo bem?'), comentários soltos ('a Cecília dormiu', 'o bolo deu errado'), desabafos, figurinhas, memes ou áudios informativos sem pergunta direta: VOCÊ DEVE MANTER SILÊNCIO ABSOLUTO (`nextAgent = 'FINISH'`, `response = '[SILENT]'`).\n" +
  "- PEDIDOS DO LUIZ NA CONTA MAIN ('main'): Se o Luiz pedir para ler mensagens, ou pedir para você enviar/responder uma mensagem na conta pessoal dele, delegue para o `whatsappAgent`.\n\n" +
  "REGRAS DE CONTEXTO E ROTEAMENTO (LEIA COM ATENÇÃO):\n" +
  "- Você receberá os dados de execução no objeto `contextData`, incluindo `executionLog` (agentes já chamados neste turno) e `activePlan` (seu plano atual, se houver).\n" +
  "- PLANEJAMENTO E LOOPS: Você PODE planejar chamar múltiplos agentes em sequência (ex: 2 buscas, depois agenda). Use o campo `plan` na saída estruturada para definir ou atualizar o seu plano (ex: [\"searchAgent\", \"calendarAgent\"]).\n" +
  "- CUMPRA SEU PLANO OBRIGATORIAMENTE: Se você definiu um plano com agentes na sequência (ex: ['weatherAgent', 'calendarAgent', 'taskAgent', 'FINISH']), você DEVE executar CADA UM deles na ordem definida. Não pule agentes do seu plano. A ÚNICA exceção é se um agente retornar uma FALHA explícita (um erro ou exceção). FALTA DE ACESSO ou LIMITAÇÃO TÉCNICA não é desculpa para pular um agente — deixe o próprio agente tentar e falhar, não desista antes de chamá-lo.\n" +
  "- Você PODE chamar o mesmo agente mais de uma vez na mesma rodada (ex: para duas pesquisas diferentes), mas avalie o `executionLog` rigorosamente para garantir que não está num LOOP INFINITO fazendo a mesma coisa repetidamente.\n" +
  "- PREVENÇÃO DE LOOP DE ERRO: Se um agente falhar ao completar uma tarefa (ex: 'FALHA:', 'não encontrei') e pedir para você encerrar a tarefa (FINISH), VOCÊ DEVE OBEDECER IMEDIATAMENTE. Defina nextAgent = 'FINISH', repasse a mensagem de erro para o usuário de forma amigável, e JAMAIS chame o agente novamente para a mesma tentativa.\n" +
  "- Se o usuário fez múltiplos pedidos, continue roteando até que TODAS as partes do pedido original sejam concluídas.\n" +
  "- Se os agentes já executaram as tarefas e não há mais nada a fazer, você DEVE formular a resposta final amigável com os resultados obtidos, definir nextAgent = 'FINISH' e colocar essa resposta no campo response. Antes de declarar FINISH, verifique seu `activePlan`: se ainda há agentes pendentes no plano, chame o PRÓXIMO agente do plano. Só vá para FINISH quando TODOS os agentes do plano tiverem sido executados ou o executionLog mostrar que todos já passaram.\n" +
  "- IMPORTANTE: Para agentes como `chitchat`, `memoryAgent` ou `whatsappAgent`, caso encerrem o assunto ou façam uma pergunta/esclarecimento diretamente ao usuário no histórico, você DEVE definir `nextAgent = 'FINISH'` e deixar o campo `response` vazio (pois eles mesmos já responderam ao usuário). Nunca crie loops insistindo na mesma tarefa se o especialista já pediu ajuda ao usuário.\n" +
  "- MENSAGENS INTERMEDIÁRIAS: Use o campo `intermediateMessage` de forma natural para avisar o usuário do que você está prestes a fazer (ex: 'Buscando as datas...'). NÃO seja robótica.\n" +
  "- MENSAGENS SOBREPOSTAS: Se a última mensagem contiver '[⚠️ Mensagem enviada enquanto você formulava a resposta anterior]' e for apenas 'Bia' ou 'ei', ignore definindo nextAgent='FINISH' e response='[SILENT]'.\n" +
  "- IGNORAR TOKENS: Se houver mensagens no histórico contendo apenas 'ENVIAR 1234' ou 'AUTORIZAR 1234' (com 4 dígitos), ignore-as completamente. Elas são processadas por outro sistema. Não roteie para nenhum agente por causa delas.\n\n" +
  "IDENTIFICAÇÃO DE ASSUNTOS (TOPICS):\n" +
  "- Você deve atuar também como classificador do assunto da conversa. Analise as mensagens recentes e identifique o assunto principal (ex: 'Festa da Cecília', 'Reforma da Casa', 'Projeto XYZ').\n" +
  "- Se a conversa girar em torno de um assunto específico (novo ou já existente no histórico), você DEVE enviar esse título resumido no campo `activeTopicTitle` dentro de `contextDataUpdate`.\n" +
  "- Se o assunto mudar no meio da conversa, atualize o `activeTopicTitle` para o novo assunto.\n" +
  "- Se a conversa for trivial ou genérica e não tiver um assunto específico para agrupar tarefas/memórias, você pode atualizar com `activeTopicTitle: null` para limpar o contexto do assunto.\n" +
  "- Se o usuário perguntar diretamente quais assuntos/tópicos existem ou estão cadastrados (ex: 'quais assuntos temos?', 'liste meus tópicos'), responda diretamente usando a lista do campo '[ASSUNTOS/TÓPICOS CADASTRADOS E DISPONÍVEIS]' com `nextAgent: 'FINISH'`.\n\n" +
  "FORMATO OBRIGATÓRIO DE RESPOSTA:\n" +
  "Responda APENAS com um objeto JSON estrito com o formato abaixo. Não adicione nenhuma explicação ou formatação markdown (sem ```json) fora dele:\n" +
  "{\n" +
  "  \\\"plan\\\": [\\\"searchAgent\\\", \\\"calendarAgent\\\"], // Seu plano de agentes. Opcional.\\n" +
  "  \\\"nextAgent\\\": \\\"searchAgent\\\" | \\\"chitchat\\\" | \\\"calendarAgent\\\" | \\\"gmailAgent\\\" | \\\"sheetsAgent\\\" | \\\"docsAgent\\\" | \\\"routineAgent\\\" | \\\"memoryAgent\\\" | \\\"taskAgent\\\" | \\\"securityAgent\\\" | \\\"shoppingAgent\\\" | \\\"whatsappAgent\\\" | \\\"reasoningAgent\\\" | \\\"weatherAgent\\\" | \\\"FINISH\\\",\\n" +
  "  \\\"reason\\\": \\\"Breve explicação do porquê desta decisão\\\",\\n" +
  "  \"response\": \"Sua resposta final compilada para o usuário caso decida por FINISH, ou vazia se for delegar\",\n" +
  "  \"intermediateMessage\": \"Mensagem proativa caso você decida avisar o que está fazendo antes de delegar (ex: 'Buscando as datas...')\",\n" +
  "  \"contextDataUpdate\": { ...dados adicionais opcionais para compartilhar com outros agentes... }\n" +
  "}\n\n" +
  "DIRETRIZES CRUCIAIS DE ESTILO E FORMATAÇÃO DA RESPOSTA (response):\n" +
  "- Responda SEMPRE de forma conversacional, em linguagem natural fluida e amigável (como um humano no chat).\n" +
  "- EVITE TOTALMENTE listagens estruturadas, marcadores de bullet points, blocos de chaves/valores, cabeçalhos ou tópicos. Em vez de escrever listas como '- Data: 19 de julho' ou '*Local:* MetLife', escreva a informação integrada naturalmente no texto: 'A grande final vai acontecer no dia 19 de julho, no estádio MetLife Stadium...'\n" +
  "- NUNCA use tabelas Markdown, divisores de linha (---), links estruturados ([texto](link)), ou títulos com hashtags (###).\n" +
  "- Use a formatação do WhatsApp (*negrito*) de forma extremamente minimalista, apenas para destacar palavras-chave realmente cruciais (como nomes de times ou o resultado final), sem poluir visualmente a conversa.\n" +
  "- Se precisar citar links, escreva a URL por extenso de maneira natural no corpo do parágrafo.";

function reformatToWhatsAppStyle(text: string): string {
  if (!text) return "";

  let result = text;

  // 1. Remove markdown headers (# ## ### etc)
  result = result.replace(/^#{1,6}\s+/gm, "");

  // 2. Remove horizontal rules (---, ***, ___)
  result = result.replace(/^(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "");

  // 3. Replace [texto](url) with texto (url)
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");

  // 4. Replace bullet points "- item" or "* item" with "• item"
  result = result.replace(/^(\s*)[-*]\s+(.+)/gm, "$1• $2");

  // 5. Remove code blocks ```code```
  result = result.replace(/```[\s\S]*?```/g, "");
  // Also remove inline code `code`
  result = result.replace(/`([^`]+)`/g, "$1");

  // 6. Replace **text** with *text* (WhatsApp bold)
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // 7. Clean up table-like fragments (| col | col |)
  result = result.replace(/^\|.+\|\s*$/gm, "");

  // 8. Normalize whitespace: max 2 consecutive newlines, trim
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.trim();

  return result;
}

export async function supervisorNode(state: typeof AgentState.State, config?: RunnableConfig) {
  const threadId = config?.configurable?.thread_id || "";
  logger.logAgentStart("supervisor", threadId, state.contextData);
  
  // Detect if this is the start of a new turn (last real message is from user)
  let isNewTurn = false;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg instanceof SystemMessage || msg instanceof RemoveMessage) continue;
    if (msg instanceof ToolMessage) {
      isNewTurn = false;
      break;
    }
    if (msg instanceof HumanMessage) {
      isNewTurn = true;
      break;
    }
    if (msg instanceof AIMessage) {
      isNewTurn = false;
      break;
    }
  }

  let currentContext = { ...state.contextData };
  if (isNewTurn) {
    logger.info("New turn detected. Resetting all execution context.");
    // Mantém apenas as propriedades core injetadas pelo sistema (whatsapp.ts)
    currentContext = {
      isTrustedChat: currentContext.isTrustedChat,
      chatJid: currentContext.chatJid,
      chatName: currentContext.chatName,
      senderJid: currentContext.senderJid,
      senderName: currentContext.senderName,
      masterNumber: currentContext.masterNumber,
      accountName: currentContext.accountName,
      active_topic_title: currentContext.active_topic_title,
      accountType: currentContext.accountType,
      userInsistsOnWhatsAppConnection: currentContext.userInsistsOnWhatsAppConnection,
      executionLog: [],
      activePlan: [],
    };
  }
  
  logger.debug(`contextData state: ${JSON.stringify(currentContext)}`);

  // Build clean dynamic prompts
  const systemPrompt = new SystemMessage(SUPERVISOR_PROMPT);
  const memoryContent = getMemory(currentContext.chatJid || "unknown", !!currentContext.isTrustedChat);
  
  let topicContext = "";
  if (currentContext.active_topic_title) {
    try {
      const topic = await getOrCreateTopicByTitle(currentContext.chatJid || "unknown", currentContext.active_topic_title);
      currentContext.activeTopicId = topic.id;
      topicContext = await compileActiveTopicContext(currentContext.chatJid || "unknown", topic.id, !!currentContext.isTrustedChat);
    } catch (e) {
      logger.error("[SUPERVISOR] Erro ao compilar contexto do assunto:", e);
    }
  }

  let activeTopicsList = "";
  try {
    const recentTopics = await getRecentTopics(currentContext.chatJid || "unknown", 15);
    if (recentTopics.length > 0) {
      activeTopicsList = `[ASSUNTOS/TÓPICOS CADASTRADOS E DISPONÍVEIS]:\n${recentTopics.map(t => `- ${t.title}`).join("\n")}`;
    }
  } catch (e) {
    logger.error("[SUPERVISOR] Erro ao buscar lista de tópicos:", e);
  }

  const contextPrompt = new SystemMessage(
    `[ESTADO DE EXECUÇÃO ATUAL (contextData)]:\n${JSON.stringify(currentContext)}\n\n` +
    `[MEMÓRIA ATIVA DA BIA E ANOTAÇÕES PRIVADAS]:\n${memoryContent}\n\n` +
    (activeTopicsList ? `${activeTopicsList}\n\n` : "") +
    (topicContext ? `${topicContext}\n\n` : "") +
    `[DATA E HORA ATUAL]: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`
  );
  
  // Filter old SystemMessages and RemoveMessages to keep history clean and optimized for Prompt Cache
  const cleanHistory = state.messages.filter(msg => !(msg instanceof SystemMessage) && !(msg instanceof RemoveMessage));
  const sanitizedHistory = sanitizeMessagesForModel(cleanHistory);
  
  // Regra de recuperação de erros para evitar loops em estados de falha
  const errorRecoveryMsg = new SystemMessage(
    "REGRA CRÍTICA DE RECUPERAÇÃO DE ERROS E PREVENÇÃO DE LOOPS:\n" +
    "- Se o histórico contém mensagens de erro de agentes anteriores, e a mensagem mais recente do usuário é sobre um assunto DIFERENTE, IGNORE completamente os erros e trate a nova mensagem normalmente.\n" +
    "- NUNCA repita uma ação que já falhou. Se algo falhou, informe brevemente e siga em frente.\n" +
    "- SE você já chamou memoryAgent neste turno E o pedido do usuário é de LEITURA/CONSULTA, NÃO chame novamente. Leia do contexto da memória fornecida.\n" +
    "- Se o usuário disser algo como 'oi', 'tudo bem?', trate como conversa NOVA e não mencione erros passados."
  );
  
  // Slice history (last 12 messages) for prompt cache optimization and to avoid model confusion
  const messagesForModel = [systemPrompt, errorRecoveryMsg, contextPrompt, ...sanitizedHistory.slice(-12)];

  // Schema da decisão da Supervisora
  const supervisorSchema = z.object({
    plan: z.array(z.string()).optional().describe("Array com os agentes planejados para serem executados, em ordem"),
    nextAgent: z.enum(["searchAgent", "chitchat", "calendarAgent", "gmailAgent", "sheetsAgent", "docsAgent", "routineAgent", "memoryAgent", "taskAgent", "securityAgent", "shoppingAgent", "whatsappAgent", "reasoningAgent", "weatherAgent", "FINISH"]),
    reason: z.string().optional(),
    response: z.string().optional(),
    intermediateMessage: z.string().optional(),
    contextDataUpdate: z.record(z.string(), z.any()).optional()
  });

  let parsed: z.infer<typeof supervisorSchema>;

  try {
    parsed = await invokeStructuredWithFallback(
      model,
      supervisorSchema,
      messagesForModel,
      {
        name: "SupervisorDecision",
        metadata: { agentName: "supervisor", threadId }
      }
    );
  } catch (fallbackErr) {
    logger.error("[SUPERVISOR] Falha total ao obter decisão estruturada. Forçando FINISH para evitar loop.", fallbackErr);
    parsed = {
      nextAgent: "FINISH",
      reason: "Falha na decodificação de decisão da supervisora.",
      response: "Desculpe, tive um problema temporário ao processar essa mensagem. Pode tentar novamente?"
    };
  }

  const updates: Record<string, any> = {
    nextAgent: parsed.nextAgent,
    contextData: {
      ...currentContext,
      ...(isNewTurn ? { __reset: true } : {}),
      ...(parsed.plan ? { activePlan: parsed.plan } : {}),
      ...(parsed.contextDataUpdate || {})
    }
  };
  
  // Propagar a atualização do título de assunto para as chaves compatíveis
  if (parsed.contextDataUpdate && 'activeTopicTitle' in parsed.contextDataUpdate) {
    updates.contextData.active_topic_title = parsed.contextDataUpdate.activeTopicTitle;
  }

  if (parsed.intermediateMessage && parsed.intermediateMessage.trim() !== "") {
    const threadId = config?.configurable?.thread_id;
    if (threadId) {
      sendIntermediateMessage(threadId, parsed.intermediateMessage, currentContext.accountName).catch(err => 
        logger.error("Failed to send intermediate message", err)
      );
    }
  }

  // Defensive mechanism: Prevent infinite loops and agent repetition
  const maxAgentCalls = 5;
  const executionLog = currentContext.executionLog || [];
  const currentExecutions = executionLog.length;

  // === Safety net contra loop do memoryAgent ===
  // Se memoryAgent foi chamado 4+ vezes, força FINISH com mensagem educada.
  const memoryCallCount = executionLog.filter(e => e === "memoryAgent").length;
  if (memoryCallCount >= 4 && updates.nextAgent === "memoryAgent") {
    logger.warn(`Loop persistente do memoryAgent: ${memoryCallCount}x. Forçando FINISH.`);
    updates.nextAgent = "FINISH";
    parsed.response = "Estou com dificuldade para acessar minhas anotações agora. Pode repetir o que precisa?";
  }

  // Detecta se o mesmo agente está sendo chamado repetidamente (fallback para outros agentes)
  const lastAgent = executionLog.length > 0 ? executionLog[executionLog.length - 1] : null;
  const isRepeatingAgent = lastAgent && updates.nextAgent === lastAgent;

  if (isRepeatingAgent) {
    logger.warn(`Loop detectado: ${updates.nextAgent} chamado repetidamente. Forçando FINISH.`);
    updates.nextAgent = "FINISH";
    if (!parsed.response) {
      parsed.response = "Deixa que já anotei isso! Se precisar de mais alguma coisa é só falar.";
    }
  } else if (updates.nextAgent !== "FINISH" && currentExecutions >= maxAgentCalls) {
    logger.warn(`Max agent calls (${maxAgentCalls}) atingido. Forçando FINISH.`);
    updates.nextAgent = "FINISH";
    if (!parsed.response) parsed.response = "Desculpe, tive que interromper pois estava demorando muito. Pode repetir de forma mais direta?";
  }
  
  // If the model populated response but didn't output FINISH. Forcing FINISH.
  if (parsed.response && parsed.response.trim() !== "" && updates.nextAgent !== "FINISH") {
    logger.warn("Model generated a response but didn't output FINISH. Forcing FINISH.");
    updates.nextAgent = "FINISH";
  }

  if (updates.nextAgent === "FINISH") {
    const messagesToRemove: RemoveMessage[] = [];
    let finalResponseText = parsed.response;

    // Fallback: Se a resposta do supervisor estiver vazia ou for [SILENT], mas um especialista executou,
    // pegamos a última mensagem do especialista para limpar e enviar
    const hasSpecialistExecuted = (currentContext.executionLog || []).length > 0;
    const isResponseEmptyOrSilent = !finalResponseText || finalResponseText.trim() === "" || finalResponseText.trim().toUpperCase() === "[SILENT]";
    if (isResponseEmptyOrSilent && hasSpecialistExecuted) {
      let lastAiMessage: AIMessage | null = null;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];
        if (msg instanceof AIMessage) {
          lastAiMessage = msg;
          break;
        }
      }
      if (lastAiMessage && typeof lastAiMessage.content === "string") {
        logger.info(`[SUPERVISOR] Usando mensagem do especialista como fallback para limpeza.`);
        finalResponseText = lastAiMessage.content;
      }
    }

    // Clean up ALL intermediate messages from this turn to prevent state bloat and loops
    let lastHumanIdx = -1;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i] instanceof HumanMessage) {
        lastHumanIdx = i;
        break;
      }
    }

    if (lastHumanIdx !== -1) {
      for (let i = lastHumanIdx + 1; i < state.messages.length; i++) {
        const msg = state.messages[i];
        if (msg.id) {
          messagesToRemove.push(new RemoveMessage({ id: msg.id }));
        }
      }
    }

    const cleanText = finalResponseText ? reformatToWhatsAppStyle(finalResponseText) : undefined;
    updates.messages = [
      ...messagesToRemove,
      ...(cleanText ? [new AIMessage(cleanText)] : [])
    ];
    updates.contextData.lastInteractionTimestamp = Date.now();
  }

  logger.logAgentDecision(
    "supervisor",
    threadId,
    updates.nextAgent,
    parsed.reason || "",
    parsed.response || "",
    parsed.intermediateMessage || ""
  );

  return updates;
}
