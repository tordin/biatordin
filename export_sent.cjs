const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
db.all("SELECT value, thread_id FROM writes WHERE type = 'json' ORDER BY rowid DESC LIMIT 500", [], (err, rows) => {
    if (err) throw err;
    rows.forEach(r => {
        try {
            const data = JSON.parse(r.value);
            if (Array.isArray(data)) {
                data.forEach(msg => {
                    if (msg.kwargs && msg.kwargs.tool_calls) {
                        msg.kwargs.tool_calls.forEach(tc => {
                            if (tc.name === 'send_message_to_target' || tc.name === 'whatsapp_send_text_message' || tc.name === 'whatsappAgent') {
                                console.log("THREAD:", r.thread_id);
                                console.log("TOOL:", tc.name);
                                console.log("ARGS:", JSON.stringify(tc.args));
                            }
                        });
                    }
                });
            }
        } catch (e) {}
    });
});
