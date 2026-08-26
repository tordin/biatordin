const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
db.all("SELECT value FROM writes WHERE thread_id LIKE '%5519997064504%' AND type = 'json' AND channel = 'messages' ORDER BY rowid DESC", [], (err, rows) => {
    if (err) throw err;
    let text = [];
    rows.forEach(r => {
        try {
            const data = JSON.parse(r.value);
            if (Array.isArray(data)) {
                data.forEach(msg => {
                    if (msg.kwargs && msg.kwargs.content) {
                        if (typeof msg.kwargs.content === 'string') {
                            text.push(msg.kwargs.id + " | " + msg.kwargs.content.substring(0, 500));
                        } else if (Array.isArray(msg.kwargs.content)) {
                            // Extract text from content array
                            msg.kwargs.content.forEach(c => {
                                if (c.type === 'text') text.push(msg.kwargs.id + " | " + c.text.substring(0, 500));
                            });
                        }
                    }
                });
            }
        } catch (e) {}
    });
    // Print first 50 unique messages (to avoid duplicates from graph checkpoints)
    const unique = [...new Set(text)];
    console.log(unique.slice(0, 50).join('\n'));
});
