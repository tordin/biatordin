const fs = require('fs');
const path = require('path');

const logsFile = path.resolve(process.cwd(), 'data/bia_detailed.jsonl');
const data = fs.readFileSync(logsFile, 'utf-8');
const lines = data.split('\n');

// Vamos corrigir TODAS as mensagens duplicadas do "[Áudio transcrito]" em qualquer TRIGGER
let changed = false;

for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
        const log = JSON.parse(lines[i]);
        if (log.event === 'TRIGGER' && log.data?.accountName === 'personal') {
            let content = log.data.messageContent || '';
            
            // 1) Corrige a duplicação bizarra de áudio
            if (content.includes('[Áudio transcrito]:\n Ah, tá joia, Luiz.')) {
                // Remove a duplicação se houver
                const parts = content.split('\n Ah, tá joia, Luiz.');
                if (parts.length > 2) {
                    content = content.replace(/\n Ah, tá joia, Luiz[\s\S]+?(?=\n|$)/g, (match, offset, string) => {
                        // Mantém a primeira ocorrência, remove a segunda adjacente
                        return ''; 
                    });
                    
                    // Maneira mais segura: apenas desduplicar blocos idênticos consecutivos
                    const linesOfContent = content.split('\n');
                    const deduped = [];
                    for(let line of linesOfContent) {
                        if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
                            deduped.push(line);
                        }
                    }
                    content = deduped.join('\n');
                }
                log.data.messageContent = content;
                changed = true;
            }
        }
    } catch(e) {}
}

if (changed) {
    fs.writeFileSync(logsFile, lines.join('\n'));
}
