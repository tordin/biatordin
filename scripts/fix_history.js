import fs from 'fs';
import path from 'path';
import { loadLidMappings, canonicalJid } from '../dist/src/utils/jidResolver.js';

// Carrega os mapeamentos do baileys antes de começar
loadLidMappings();

const historyDir = path.join(process.cwd(), 'data', 'history', 'personal');
const logsFile = path.join(process.cwd(), 'data', 'bia_detailed.jsonl');
const MASTER_NUMBER = process.env.MASTER_NUMBER || "5519997064504@s.whatsapp.net";

console.log("=== Corrigindo Histórico (JSONs) ===");
const historyMap = new Map();

if (fs.existsSync(historyDir)) {
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
        const filePath = path.join(historyDir, file);
        let changed = false;
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            for (const msg of data) {
                if (msg.isFromMe) {
                    if (msg.sender !== MASTER_NUMBER || msg.senderName !== "Luiz") {
                        msg.sender = MASTER_NUMBER;
                        msg.senderName = "Luiz";
                        changed = true;
                    }
                }
            }
            if (changed) {
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
                console.log(`[CORRIGIDO] ${file}`);
            }
            // A chave é o JID canônico (sem a extensão .json)
            historyMap.set(file.replace('.json', ''), data);
        } catch(e) {
            console.error(`Erro ao processar ${file}:`, e.message);
        }
    }
} else {
    console.log("Diretório de histórico personal não encontrado.");
}

console.log("\n=== Corrigindo Logs do Debugger (bia_detailed.jsonl) ===");
if (fs.existsSync(logsFile)) {
    const lines = fs.readFileSync(logsFile, 'utf-8').split('\n');
    let logsChanged = false;
    let fixedCount = 0;
    
    const newLines = lines.map((line, index) => {
        if (!line.trim()) return line;
        try {
            const log = JSON.parse(line);
            if (log.event === 'TRIGGER' && log.data?.accountName === 'personal' && log.data?.metadata?.isGroup === false) {
                const content = log.data.messageContent;
                if (content && typeof content === 'string') {
                    const pieces = content.split('\n---\n');
                    const rawJid = log.data.chatJid;
                    const resolvedJid = canonicalJid(rawJid);
                    const history = historyMap.get(resolvedJid) || [];
                    
                    let needsUpdate = false;

                    // 1. Corrige o chatName se for um JID feio
                    if (log.data.chatName && log.data.chatName.includes('@')) {
                        const contactMsg = history.slice().reverse().find(h => !h.isFromMe && h.senderName);
                        if (contactMsg && contactMsg.senderName) {
                            log.data.chatName = contactMsg.senderName;
                            needsUpdate = true;
                        }
                    }

                    // 2. Corrige o formato das mensagens e agrupa blocos contínuos do mesmo remetente
                    const newPieces = [];
                    let lastSender = null;
                    
                    for (const piece of pieces) {
                        let currentSender = null;
                        let textContent = piece;
                        
                        // Verifica se já tem o formato antigo (com espaço)
                        const oldMatch = piece.match(/^(.+?): (.*)/s);
                        // Verifica se já tem o formato novo (com \n)
                        const newMatch = piece.match(/^(.+?):\n(.*)/s);
                        
                        if (oldMatch) {
                            currentSender = oldMatch[1];
                            textContent = oldMatch[2];
                            needsUpdate = true;
                        } else if (newMatch) {
                            currentSender = newMatch[1];
                            textContent = newMatch[2];
                        } else {
                            // Busca a mensagem correspondente no histórico (de trás pra frente é mais provável)
                            const match = history.slice().reverse().find(h => 
                                h.content.trim() === piece.trim() || 
                                h.content.includes(piece.trim())
                            );
                            
                            if (match) {
                                currentSender = match.isFromMe ? "Luiz" : (match.senderName || log.data.chatName || 'Contato');
                                needsUpdate = true;
                            } else {
                                // Se não achou de forma alguma, mantém o original
                                currentSender = "Desconhecido"; 
                            }
                        }
                        
                        // Se for o mesmo remetente do bloco anterior, agrupa (não repete o nome nem o ---)
                        if (currentSender === lastSender && currentSender !== "Desconhecido") {
                            newPieces[newPieces.length - 1] += `\n${textContent}`;
                            needsUpdate = true;
                        } else {
                            const prefix = currentSender !== "Desconhecido" ? `${currentSender}:\n` : "";
                            newPieces.push(`${prefix}${textContent}`);
                            lastSender = currentSender;
                        }
                    }
                    
                    if (needsUpdate) {
                        log.data.messageContent = newPieces.join('\n---\n');
                        logsChanged = true;
                        fixedCount++;
                        return JSON.stringify(log);
                    }
                }
            }
            return line;
        } catch(e) {
            return line; // Se não for JSON válido, ignora
        }
    });

    if (logsChanged) {
        fs.writeFileSync(logsFile, newLines.join('\n'));
        console.log(`[SUCESSO] bia_detailed.jsonl atualizado! ${fixedCount} eventos corrigidos.`);
    } else {
        console.log("Nenhuma correção pendente no bia_detailed.jsonl");
    }
} else {
    console.log("bia_detailed.jsonl não encontrado.");
}
