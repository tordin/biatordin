const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
db.all("SELECT value, thread_id FROM writes WHERE type = 'json' AND value LIKE '%5519999021962%' ORDER BY rowid DESC", [], (err, rows) => {
    if (err) throw err;
    rows.forEach(r => {
        try {
            const data = JSON.parse(r.value);
            if (Array.isArray(data)) {
                data.forEach(msg => {
                    if (msg.kwargs && msg.kwargs.tool_calls) {
                        msg.kwargs.tool_calls.forEach(tc => {
                            if (tc.name === 'send_message_to_target' || tc.name === 'whatsapp_send_text_message') {
                                if (tc.args && (tc.args.targetNumber === '5519999021962@s.whatsapp.net' || tc.args.to === '5519999021962@s.whatsapp.net')) {
                                    console.log("THREAD:", r.thread_id);
                                    console.log("TOOL:", tc.name);
                                    console.log("ARGS:", JSON.stringify(tc.args));
                                }
                            }
                        });
                    }
                });
            }
        } catch (e) {}
    });
});
