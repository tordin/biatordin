const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
db.all("SELECT value FROM writes WHERE thread_id LIKE '%5519999021962%' AND type = 'json' ORDER BY rowid DESC", [], (err, rows) => {
    if (err) throw err;
    rows.forEach(r => {
        try {
            const data = JSON.parse(r.value);
            if (Array.isArray(data)) {
                data.forEach(msg => {
                    if (msg.kwargs && msg.kwargs.tool_calls) {
                        msg.kwargs.tool_calls.forEach(tc => {
                            if (tc.name === 'send_message_to_target') {
                                console.log("SENT TO CAROL:", tc.args.message);
                            }
                        });
                    }
                });
            }
        } catch (e) {}
    });
});
