import { getContextDocument, saveContextDocument } from './contextDocuments.js';
import { addVectorMemory } from './vectorMemory.js';
import { modelFlash } from '../llm/model.js';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { logger } from '../utils/logger.js';
import { z } from 'zod';
import { invokeStructuredWithFallback } from '../utils/structuredOutput.js';

const compactorSchema = z.object({
  compactedDocument: z.string().describe("O novo documento Markdown compactado, preservando regras sagradas e consolidando o histórico."),
  extractedHistory: z.array(z.string()).default([]).describe("Lista de fatos históricos ou anotações transitórias que foram resumidos ou removidos do documento vivo para arquivamento no RAG de longo prazo.")
});

export async function checkAndCompactContextDocument(topicId: string, chatJid: string, isTrustedChat: boolean, force: boolean = false): Promise<void> {
  const doc = await getContextDocument(topicId);
  if (!doc) return;

  if (!force && doc.content.length <= doc.max_characters) {
    return; // Within budget
  }

  logger.info(`[DOCUMENT COMPACTOR] Documento ${topicId} excedeu limite ou foi forçado. Iniciando compactação síncrona.`);

  try {
    const prompt = new SystemMessage(
      `Você é um assistente de IA especialista em manutenção de memória (Semantic Compactor).\n` +
      `Sua tarefa é ler um "Documento Vivo" que cresceu demais e destilá-lo.\n\n` +
      `DIRETRIZES OBRIGATÓRIAS:\n` +
      `1. PRESERVAÇÃO SAGRADA: Mantenha sempre (sem alterar) as regras ativas, diretrizes permanentes, restrições (ex: alimentares, orçamentárias), acordos de preço e preferências consolidadas. Isso NUNCA deve ser apagado.\n` +
      `2. SUMARIZAÇÃO DE HISTÓRICO: Identifique blocos de diário/histórico com várias entradas e sumarize-os concisamente. Ex: Em vez de 10 dias detalhados, escreva um parágrafo resumindo as tendências e anomalias desse período.\n` +
      `3. EXPURGO DE TRIVIALIDADES: Remova anotações temporárias velhas, rascunhos ou pendências concluídas que não afetam mais as decisões futuras.\n` +
      `4. ARQUIVAMENTO: Tudo o que você resumir, expurgar ou remover do documento VIVO deve ser adicionado à matriz \`extractedHistory\`. Nós guardaremos isso no RAG vetorial de longo prazo para não perder os detalhes.\n` +
      `5. ESTRUTURA: Devolva o documento resultante em \`compactedDocument\` usando formatação Markdown clara (títulos, listas).\n\n` +
      `ATENÇÃO: O documento deve ficar significativamente menor sem perder o core operacional.`
    );

    const userMsg = new HumanMessage(`DOCUMENTO ATUAL (Tópico: ${doc.title}):\n\n${doc.content}`);

    const result = await invokeStructuredWithFallback(
      modelFlash,
      compactorSchema,
      [prompt, userMsg],
      { name: "DocumentCompactor", metadata: { topicId } }
    );

    // Save the compacted doc
    await saveContextDocument(topicId, doc.title, result.compactedDocument);

    // Archive the extracted history
    if (result.extractedHistory && result.extractedHistory.length > 0) {
      for (const historyFact of result.extractedHistory) {
        await addVectorMemory(
          historyFact,
          'historico',
          chatJid,
          { topicId, origin: 'context_document_compaction' },
          0.3 // Low importance for pure history
        );
      }
      logger.info(`[DOCUMENT COMPACTOR] ${result.extractedHistory.length} fatos históricos extraídos e arquivados no RAG.`);
    }

    logger.info(`[DOCUMENT COMPACTOR] Compactação concluída. Novo tamanho: ${result.compactedDocument.length} caracteres.`);

  } catch (error) {
    logger.error(`[DOCUMENT COMPACTOR] Erro na compactação do documento ${topicId}:`, error);
  }
}
