import 'dotenv/config';
import { agent } from '../src/graph/workflow.js';
import { HumanMessage } from '@langchain/core/messages';
import { getActiveMissionsForChat } from '../src/memory/missions.js';
import { triggerSimulator } from '../src/utils/simulator.js';
import { MASTER_NUMBER } from '../src/memory/security.js';
import OpenAI from 'openai';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// Groq/OpenAI client for the Master Simulator
const openai = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

// Polyfill/Intercept whatsapp module
import * as whatsapp from '../src/transport/whatsapp.js';

let evalLog = "";
function logAndPrint(msg: string) {
    console.log(msg);
    evalLog += msg + "\n";
}

const EVAL_TARGET_JID = "5568911112222@s.whatsapp.net";
const EVAL_MASTER_JID = "233070879867118@lid";
let currentThreadId = uuidv4();

const INITIAL_PROMPT = "Bia, o vendedor Marcos (telefone 68 91111-2222) está anunciando uma moto Honda Biz 125. Pergunte o ano, a quilometragem, se tem multas, e se ele faz por R$ 8.000 à vista.";

import { _setGlobalSockForTest, _popSimulatedMessages } from '../src/transport/whatsapp.js';

let masterInbox: string[] = [];

// Usando o setGlobalSock para interceptar os envios sem erro de read-only
const dummySock = {
    sendPresenceUpdate: async () => {},
    readMessages: async () => {},
    sendMessage: async (jid: string, msg: any) => {
        const text = msg.text;
        if (jid === MASTER_NUMBER) {
            logAndPrint(`\n[BIA -> MASTER]: ${text}`);
            masterInbox.push(text);
        } else if (jid === EVAL_TARGET_JID) {
            logAndPrint(`\n[BIA -> TARGET (${jid})]: ${text}`);
            // NOTA: Mensagens pro Target são interceptadas pelo simulador no whatsapp.ts
        } else {
            logAndPrint(`\n[BIA -> DESCONHECIDO (${jid})]: ${text}`);
        }
    }
};

// @ts-ignore
_setGlobalSockForTest(dummySock);

async function simulateMasterLLM(biaMessage: string): Promise<string> {
    const prompt = `Você é o Luiz, testando uma assistente virtual (Bia). Você pediu a ela para negociar uma Honda Biz usada com o Marcos.
A Bia acabou de te enviar esta notificação:
"${biaMessage}"

Responda de forma natural, dando a próxima instrução para a Bia (ex: se ela perguntar se pode fechar, diga que sim. Se ela passar dados, peça para seguir). Seja breve. Não use aspas na sua resposta.`;
    
    const response = await openai.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: prompt }]
    });
    return response.choices[0].message.content || "Ok, pode seguir.";
}

async function runBiaTurn(senderJid: string, senderName: string, text: string) {
    logAndPrint(`\n[${senderName} -> BIA]: ${text}`);
    
    const humanMessages = [new HumanMessage({ content: text, name: senderName })];
    const activeMissions = await getActiveMissionsForChat(senderJid);
    
    const config = { 
        configurable: { thread_id: currentThreadId },
        metadata: { threadId: currentThreadId, agentName: "graph" },
        recursionLimit: 25
    };

    const contextData = {
        isTrustedChat: senderJid === EVAL_MASTER_JID,
        chatJid: senderJid,
        chatName: senderName,
        senderJid: senderJid,
        senderName: senderName,
        masterNumber: MASTER_NUMBER,
        accountName: "main",
        activeMissions: activeMissions
    };

    logAndPrint(`[SYSTEM] Invocando o Grafo da Bia...`);
    const result = await agent.invoke({
        messages: humanMessages,
        contextData
    }, config);

    const agentsUsed = result.contextData?.executionLog || [];
    logAndPrint(`[SYSTEM] Agentes utilizados no turno: ${agentsUsed.join(' -> ')}`);

    const responseMessage = result.messages[result.messages.length - 1];
    let responseText = (typeof responseMessage.content === 'string' ? responseMessage.content : JSON.stringify(responseMessage.content));
    
    if (responseText && responseText !== "[SILENT]") {
        logAndPrint(`\n[BIA (Conversacional) -> ${senderName}]: ${responseText}`);
    }
}

async function runEval() {
    logAndPrint("=== INICIANDO AVALIAÇÃO AUTÔNOMA E2E ===");
    
    // 1. Inicia com o Master dando a ordem
    await runBiaTurn(EVAL_MASTER_JID, "Luiz", INITIAL_PROMPT);

    // Loop de no máximo 10 turnos
    for (let i = 0; i < 10; i++) {
        // Pega mensagens injetadas pelo simulador no whatsapp.ts
        let simulatedMsgs = _popSimulatedMessages();
        let targetInbox = simulatedMsgs.filter(m => m.remoteJid === EVAL_TARGET_JID || m.userJid === EVAL_TARGET_JID);

        // Como o triggerSimulator no whatsapp.ts roda em background (não sofre await),
        // precisamos fazer um pequeno polling se a caixa estiver vazia
        let retries = 0;
        // Pessoas normais podem quebrar mensagens e a IA pode colocar um delayMs maior (ex: 8 segundos).
        // 30 retries de 1s dá 30 segundos de tolerância para receber todas as partes simuladas.
        while (masterInbox.length === 0 && targetInbox.length === 0 && retries < 30) {
            await new Promise(r => setTimeout(r, 1000));
            simulatedMsgs = _popSimulatedMessages();
            targetInbox = simulatedMsgs.filter(m => m.remoteJid === EVAL_TARGET_JID || m.userJid === EVAL_TARGET_JID);
            retries++;
        }

        if (masterInbox.length === 0 && targetInbox.length === 0) {
            logAndPrint(`\n[SYSTEM] Nenhuma mensagem pendente nas filas após aguardar. Simulação pausada/encerrada.`);
            break;
        }

        // Processa mensagens pendentes para o Alvo
        if (targetInbox.length > 0) {
            const msgObj = targetInbox.shift()!;
            await runBiaTurn(EVAL_TARGET_JID, "Contato Simulado", msgObj.text);
            continue; // Avalia uma por vez
        }

        // Processa mensagens pendentes para o Master
        if (masterInbox.length > 0) {
            const msg = masterInbox.shift()!;
            logAndPrint(`[SYSTEM] Acionando LLM do Master Simulado...`);
            const masterReply = await simulateMasterLLM(msg);
            await runBiaTurn(EVAL_MASTER_JID, "Luiz", masterReply);
            continue;
        }
    }

    logAndPrint("\n=== SIMULAÇÃO CONCLUÍDA ===");
    fs.mkdirSync('logs', { recursive: true });
    fs.writeFileSync('logs/eval_last_run.txt', evalLog);
    logAndPrint(`Log salvo em logs/eval_last_run.txt`);
    process.exit(0);
}

runEval().catch(console.error);
