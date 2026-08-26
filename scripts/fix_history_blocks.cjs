const fs = require('fs');
const path = require('path');

const logsFile = path.resolve(process.cwd(), 'data/bia_detailed.jsonl');
const historyFile = path.resolve(process.cwd(), 'data/history/personal/5519999021962@s.whatsapp.net.json');

const data = fs.readFileSync(logsFile, 'utf-8');
const lines = data.split('\n');

const histData = fs.readFileSync(historyFile, 'utf-8');
const history = JSON.parse(histData);

// Função para agrupar mensagens e formatá-las como string
function groupAndFormat(messages) {
    let groupedMessages = [];
    for (const m of messages) {
        if (groupedMessages.length > 0 && groupedMessages[groupedMessages.length - 1].senderName === m.senderName) {
            groupedMessages[groupedMessages.length - 1].content += `\n${m.content}`;
        } else {
            groupedMessages.push({ ...m });
        }
    }
    return groupedMessages.map(m => {
        return `${m.senderName}:\n${m.content}`;
    }).join('\n---\n');
}

// 1. O bloco grande de 92 mensagens
const startIndexBig = history.findIndex(m => m.content.includes('oi! bom dia'));
const blockBig = history.slice(startIndexBig); // Pega de "oi! bom dia" até o final (inclui o áudio de 9min)
const formattedBig = groupAndFormat(blockBig);

let changed = false;

for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
        const log = JSON.parse(lines[i]);
        if (log.event === 'TRIGGER' && log.data?.accountName === 'personal') {
            
            // Corrige o bloco grande identificando apenas pelo áudio de 9min que está nele
            if (log.data?.messageContent?.includes('limite máximo de 5 minutos')) {
                log.data.messageContent = formattedBig;
                lines[i] = JSON.stringify(log);
                changed = true;
                console.log("Restaurou as 92 mensagens do bloco grande!");
            }
        }
    } catch(e) {}
}

if (changed) {
    fs.writeFileSync(logsFile, lines.join('\n'));
}
