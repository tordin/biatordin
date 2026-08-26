const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
db.all("SELECT value FROM writes WHERE thread_id LIKE '%5519997064504%' AND type = 'json' ORDER BY rowid DESC LIMIT 100", [], (err, rows) => {
    if (err) throw err;
    rows.forEach(r => {
        try {
            const data = JSON.parse(r.value);
            if (Array.isArray(data)) {
                data.forEach(msg => {
                    if (msg.kwargs && msg.kwargs.tool_calls && msg.kwargs.tool_calls.length > 0) {
                        msg.kwargs.tool_calls.forEach(tc => {
                            if (tc.name === 'start_mission' || tc.name === 'send_message_to_target' || tc.name === 'notify_master') {
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
