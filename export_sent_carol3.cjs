const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');
db.all("SELECT value, thread_id FROM writes WHERE type = 'json' AND value LIKE '%5519999021962%' ORDER BY rowid DESC LIMIT 10000", [], (err, rows) => {
    if (err) throw err;
    rows.forEach(r => {
        try {
            const data = JSON.parse(r.value);
            if (Array.isArray(data)) {
                data.forEach(msg => {
                    if (msg.kwargs && msg.kwargs.tool_calls) {
                        msg.kwargs.tool_calls.forEach(tc => {
                            if (JSON.stringify(tc.args).includes('5519999021962')) {
                                console.log("THREAD:", r.thread_id);
                                console.log("TOOL:", tc.name);
                                console.log("ARGS:", JSON.stringify(tc.args));
                                console.log("----------");
                            }
                        });
                    }
                });
            }
        } catch (e) {}
    });
});
