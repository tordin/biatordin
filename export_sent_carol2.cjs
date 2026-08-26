const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
db.all("SELECT value, thread_id FROM writes WHERE type = 'json' AND value LIKE '%send_message_to_target%' ORDER BY rowid DESC LIMIT 5000", [], (err, rows) => {
    if (err) throw err;
    rows.forEach(r => {
        try {
            const data = JSON.parse(r.value);
            if (Array.isArray(data)) {
                data.forEach(msg => {
                    if (msg.kwargs && msg.kwargs.tool_calls) {
                        msg.kwargs.tool_calls.forEach(tc => {
                            if (tc.name === 'send_message_to_target') {
                                if (tc.args && typeof tc.args.targetNumber === 'string' && tc.args.targetNumber.includes('5519999021962')) {
                                    console.log("THREAD:", r.thread_id);
                                    console.log("MESSAGE:", tc.args.message);
                                    console.log("----------");
                                }
                            }
                        });
                    }
                });
            }
        } catch (e) {}
    });
});
