const fs = require('fs');
const path = require('path');

const logsFile = path.resolve(process.cwd(), 'data/bia_detailed.jsonl');
const historyFile = path.resolve(process.cwd(), 'data/history/personal/5519999021962@s.whatsapp.net.json');

const data = fs.readFileSync(logsFile, 'utf-8');
const lines = data.split('\n');

const histData = fs.readFileSync(historyFile, 'utf-8');
const history = JSON.parse(histData);

// Pega os últimos ~25 elementos do history
const recentHistory = history.slice(-25);

// Reconstrói o texto
let groupedMessages = [];
for (const m of recentHistory) {
    if (groupedMessages.length > 0 && groupedMessages[groupedMessages.length - 1].senderName === m.senderName) {
        groupedMessages[groupedMessages.length - 1].content += `\n${m.content}`;
    } else {
        groupedMessages.push({ ...m });
    }
}

// Filtra para pegar apenas a partir de "oi! bom dia"
const startIndex = groupedMessages.findIndex(m => m.content.includes('oi! bom dia'));
if (startIndex !== -1) {
    groupedMessages = groupedMessages.slice(startIndex);
}

let fullCombinedText = groupedMessages.map(m => {
    return `${m.senderName}:\n${m.content}`;
}).join('\n---\n');

let changed = false;
for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
        const log = JSON.parse(lines[i]);
        if (log.event === 'TRIGGER' && log.data?.accountName === 'personal' && log.data?.messageContent?.includes('Sobra ')) {
            log.data.messageContent = fullCombinedText;
            lines[i] = JSON.stringify(log);
            changed = true;
            console.log("Trigger corrigido e estendido com o áudio!");
        }
    } catch(e) {}
}

if (changed) {
    fs.writeFileSync(logsFile, lines.join('\n'));
}
