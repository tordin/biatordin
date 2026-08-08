import { ChatPromptTemplate } from "@langchain/core/prompts";
import { modelFlashStructured } from "../llm/model.js";
import { logger } from "./logger.js";
import { z } from "zod";

// Histórico efêmero para manter o contexto das simulações durante a execução
const simulatorHistory = new Map<string, { role: 'system' | 'user' | 'assistant', content: string }[]>();

const SimResponseSchema = z.object({
    messages: z.array(z.object({
        text: z.string().describe("O texto da mensagem."),
        delayMs: z.number().describe("Tempo de espera (em milissegundos) antes de enviar esta mensagem, simulando a digitação ou pausa para pensar. Use 1000 a 3000 para quebras normais de parágrafos. Use 5000 a 8000 para simular uma resposta de follow-up mais tarde (ex: 'e aí, pensou?').")
    })).describe("Lista de mensagens que a pessoa enviou em sequência para responder. Retorne uma lista VAZIA se a conversa chegou a uma conclusão natural e você não tem mais nada a acrescentar (evita loop infinito).")
});

/**
 * Aciona a IA para simular a resposta de um "Target" fictício.
 * @param targetJid O JID do alvo simulado
 * @param message A mensagem recebida da Bia
 * @returns Array de mensagens com delay simulado
 */
export async function triggerSimulator(targetJid: string, message: string): Promise<{ text: string, delayMs: number }[]> {
    try {
        if (!simulatorHistory.has(targetJid)) {
            simulatorHistory.set(targetJid, [
                {
                    role: 'system',
                    content: `Você é uma pessoa normal conversando no WhatsApp. Você está sendo contatado para uma negociação, agendamento ou conversa. Entenda o contexto da primeira mensagem recebida e responda de forma natural, curta, direta e conversacional.
REGRAS IMPORTANTES:
1. Pessoas no WhatsApp não mandam um textão com vários pontos. Elas quebram a ideia em várias mensagens curtas.
2. Aja como um humano comum (com gírias leves, erros de digitação ocasionais, reações curtas).
3. NUNCA revele que você é uma IA simulada.
4. Se a oferta for ruim, negocie ou recuse. Se for boa, aceite.
5. EXTREMAMENTE IMPORTANTE: Se a conversa chegou ao fim (ex: ambas as partes se despediram, agradeceram, ou o assunto morreu), PARE DE RESPONDER. Retorne uma lista vazia de mensagens para encerrar o papo e evitar um loop infinito de agradecimentos e tchau.
6. ATENÇÃO AOS PAPÉIS: Você é o CLIENTE/HUMANO. A pessoa que está enviando mensagens para você (o 'user' no histórico) é a Bia (uma Assistente Virtual). NÃO SE CONFUNDA: você NÃO é a Bia.`
                }
            ]);
        }

        const history = simulatorHistory.get(targetJid)!;
        history.push({ role: 'user', content: message });


        const messagesForModel = history.map(h => [h.role, h.content] as [string, string]);
        const prompt = ChatPromptTemplate.fromMessages(messagesForModel);
        
        const structuredModel = modelFlashStructured.withStructuredOutput(SimResponseSchema);
        const chain = prompt.pipe(structuredModel);
        const response = await chain.invoke({});
        
        const combinedText = response.messages.map((m: any) => m.text).join(" | ");
        history.push({ role: 'assistant', content: combinedText });

        return response.messages;
    } catch (error) {
        logger.error(`[SIMULATOR] Erro ao simular resposta para ${targetJid}:`, error);
        return [{ text: "Erro interno no simulador.", delayMs: 1000 }];
    }
}
