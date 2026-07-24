import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.resolve(process.cwd(), 'data/bia_detailed.jsonl');
const PORT = process.env.PORT || 3456;

// SSE clients
const clients = new Set();

// Watch file for changes
let fileSize = 0;
try { fileSize = fs.statSync(DATA_FILE).size; } catch {}

fs.watch(DATA_FILE, (eventType) => {
  if (eventType === 'change') broadcastNewLines();
});

function broadcastNewLines() {
  try {
    const newSize = fs.statSync(DATA_FILE).size;
    if (newSize <= fileSize) return;
    const stream = fs.createReadStream(DATA_FILE, { start: fileSize, end: newSize, encoding: 'utf-8' });
    let buffer = '';
    stream.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          const data = `data: ${line}\n\n`;
          for (const client of clients) client.write(data);
        }
      }
    });
    stream.on('end', () => {
      if (buffer.trim()) {
        const data = `data: ${buffer}\n\n`;
        for (const client of clients) client.write(data);
      }
    });
    fileSize = newSize;
  } catch {}
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ─── Turn Building ────────────────────────────────────────
const RECEBIDO_RE = /Recebido de\s+\S+\s+\(([^)]+)\):\s*"(.*?)"\s*\.\s*Adicionando à fila\.?$/s;

function createTurnObject({ triggerId, timestamp, triggerType, userMessage, chatType, chatName, senderName, accountName, threadId, entry }) {
  return {
    timestamp: timestamp || new Date().toISOString(),
    triggerId: triggerId || null,
    triggerType: triggerType || 'whatsapp_message',
    userMessage: userMessage || '',
    chatType: chatType || 'Privado',
    chatName: chatName || '',
    senderName: senderName || '',
    accountName: accountName || '',
    threadId: threadId || '',
    topic: '',
    summary: '',
    finalDecision: '',
    finalResponse: '',
    action: '',
    agentsUsed: [],
    toolsRan: [],
    intermediateMessages: [],
    decisions: [],
    durationMs: 0,
    hasError: false,
    events: entry ? [entry] : []
  };
}

function processEntryDetails(turn, entry) {
  if (!entry) return;
  const ev = entry.event;
  const data = entry.data || {};

  if (ev === 'AGENT_DECISION') {
    const dec = {
      agent: entry.agentName || 'supervisor',
      nextAgent: data.nextAgent || '',
      reason: data.reason || '',
      response: data.response || '',
      intermediateMessage: data.intermediateMessage || ''
    };
    turn.decisions.push(dec);
    if (data.reason && !turn.summary) turn.summary = data.reason;
    if (data.nextAgent) turn.finalDecision = data.nextAgent;
    if (data.response && data.response !== '[SILENT]' && !turn.finalResponse) {
      turn.finalResponse = data.response;
    }
    if (data.intermediateMessage) {
      turn.intermediateMessages.push(data.intermediateMessage);
    }
  } else if (ev === 'LLM_END') {
    const gens = data.generations || [];
    for (const gen of gens) {
      for (const item of gen) {
        if (item.type === 'tool_calls' && item.toolCalls) {
          for (const tc of item.toolCalls) {
            const name = tc.name;
            if (name && name !== 'TopicClassification' && name !== 'SupervisorDecision') {
              turn.toolsRan.push({
                agent: entry.agentName || '',
                tool: name,
                args: tc.args || {}
              });
            }
          }
        } else if (item.type === 'message' && item.content) {
          if (!turn.finalResponse && entry.agentName && entry.agentName !== 'supervisor' && entry.agentName !== 'topic_broker') {
            turn.finalResponse = item.content;
          }
        }
      }
    }
  } else if (ev === 'TRIGGER_END') {
    turn.action = data.action || turn.action;
    if (data.responseText) turn.finalResponse = data.responseText;
    if (data.agentsUsed) turn.agentsUsed = data.agentsUsed;
    if (data.durationMs) turn.durationMs = data.durationMs;
  } else if (ev === 'ERROR') {
    turn.hasError = true;
  } else if (ev === 'INFO' && data.message && data.message.includes('Direcionando mensagens para o assunto')) {
    const topicMatch = data.message.match(/assunto:\s*"([^"]+)"/);
    if (topicMatch) turn.topic = topicMatch[1];
  }
}

function buildTurns(entries) {
  const turns = [];
  const turnById = new Map();
  let currentTurn = null;

  for (const entry of entries) {
    if (!entry) continue;
    const ev = entry.event;
    const data = entry.data || {};
    const tid = entry.triggerId || data.triggerId;

    if (tid && turnById.has(tid)) {
      const targetTurn = turnById.get(tid);
      if (ev === 'TRIGGER') {
        if (data.messageContent) targetTurn.userMessage = data.messageContent;
        if (data.chatName) targetTurn.chatName = data.chatName;
        if (data.senderName) targetTurn.senderName = data.senderName;
        if (data.accountName) targetTurn.accountName = data.accountName;
        if (entry.triggerType || data.triggerType) targetTurn.triggerType = entry.triggerType || data.triggerType;
        if (data.chatJid) {
          targetTurn.chatType = data.chatJid.includes('@g.us') ? 'Grupo' : (data.chatJid.includes('@lid') ? 'LID (Privado)' : 'Privado');
        }
      }
      targetTurn.events.push(entry);
      processEntryDetails(targetTurn, entry);
      continue;
    }

    if (ev === 'TRIGGER') {
      const chatJid = data.chatJid || '';
      const turn = createTurnObject({
        triggerId: tid,
        timestamp: entry.timestamp,
        triggerType: entry.triggerType || data.triggerType || 'whatsapp_message',
        userMessage: data.messageContent || '',
        chatType: chatJid.includes('@g.us') ? 'Grupo' : (chatJid.includes('@lid') ? 'LID (Privado)' : 'Privado'),
        chatName: data.chatName || '',
        senderName: data.senderName || '',
        accountName: data.accountName || '',
        threadId: entry.threadId || '',
        entry
      });
      turns.push(turn);
      if (tid) turnById.set(tid, turn);
      currentTurn = turn;
      processEntryDetails(turn, entry);
      continue;
    }

    // Fallback: check for Recebido log message
    const msgStr = data.message || '';
    const m = msgStr.match(RECEBIDO_RE);
    if (m) {
      const cType = m[1];
      const text = m[2].trim();
      const rawText = text.replace(/^\[Áudio transcrito\]:\s*/i, '').trim();

      // Check if there is already a turn created recently (within 45s) for the same chat/type
      const recentTurn = turns.find(t => {
        const diff = Math.abs(new Date(entry.timestamp).getTime() - new Date(t.timestamp).getTime());
        return diff < 45000 && (
          (t.userMessage && (t.userMessage.includes(rawText) || rawText.includes(t.userMessage))) ||
          (!t.triggerId && t.chatType === cType)
        );
      });

      if (recentTurn) {
        recentTurn.events.push(entry);
        if (!recentTurn.triggerId && !recentTurn.userMessage.includes(rawText)) {
          recentTurn.userMessage = recentTurn.userMessage ? `${recentTurn.userMessage}\n${text}` : text;
        }
        processEntryDetails(recentTurn, entry);
        continue;
      }

      const turn = createTurnObject({
        triggerId: tid,
        timestamp: entry.timestamp,
        triggerType: 'whatsapp_message',
        userMessage: text,
        chatType: cType,
        chatName: cType,
        senderName: '',
        accountName: '',
        threadId: entry.threadId || '',
        entry
      });
      turns.push(turn);
      if (tid) turnById.set(tid, turn);
      currentTurn = turn;
      processEntryDetails(turn, entry);
      continue;
    }

    // Otherwise append to target turn ONLY if it has an explicit matching triggerId
    const targetTurn = tid ? turnById.get(tid) : null;
    if (!targetTurn) continue;
    targetTurn.events.push(entry);
    processEntryDetails(targetTurn, entry);
  }

  // Pass 2: Merge orphaned dummy fallback turns (without triggerId) into nearby real TRIGGER turns ONLY IF they represent user messages or decisions
  const finalTurns = [];
  const mergedIndices = new Set();

  for (let i = 0; i < turns.length; i++) {
    if (mergedIndices.has(i)) continue;
    const t = turns[i];

    if (!t.triggerId) {
      // Only consider merging if this dummy turn actually contains a user message or decision
      const hasContentToMerge = (t.userMessage && t.userMessage.trim().length > 0) || t.decisions.length > 0;
      if (!hasContentToMerge) {
        mergedIndices.add(i);
        continue;
      }

      // Look for a real TRIGGER turn within 45 seconds
      const targetRealTurnIndex = turns.findIndex((other, j) => {
        if (j === i || mergedIndices.has(j) || !other.triggerId) return false;
        const diff = Math.abs(new Date(t.timestamp).getTime() - new Date(other.timestamp).getTime());
        return diff < 45000;
      });

      if (targetRealTurnIndex !== -1) {
        const realTurn = turns[targetRealTurnIndex];
        // Merge events
        for (const ev of t.events) {
          if (!realTurn.events.includes(ev)) realTurn.events.push(ev);
        }
        // Merge userMessage if distinct and realTurn doesn't already have a triggerId-provided userMessage
        const cleanT = t.userMessage.replace(/^\[Áudio transcrito\]:\s*/i, '').trim();
        const cleanReal = realTurn.userMessage.replace(/^\[Áudio transcrito\]:\s*/i, '').trim();
        if (cleanT && !cleanReal.includes(cleanT) && !realTurn.triggerId) {
          realTurn.userMessage = `${t.userMessage}\n${realTurn.userMessage}`;
        }
        // Merge decisions if realTurn has none
        if (realTurn.decisions.length === 0 && t.decisions.length > 0) {
          realTurn.decisions = [...t.decisions];
          if (t.summary) realTurn.summary = t.summary;
          if (t.finalDecision) realTurn.finalDecision = t.finalDecision;
          if (t.finalResponse) realTurn.finalResponse = t.finalResponse;
        }
        mergedIndices.add(i);
        continue;
      }
    }

    finalTurns.push(t);
  }

  // Sort events inside each turn chronologically
  for (const t of finalTurns) {
    t.events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  return finalTurns;
}

// ─── Request Handlers ──────────────────────────────────────

function readAllEntries() {
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return raw.split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function handleTurns(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const search = (url.searchParams.get('search') || '').toLowerCase();
  const chatType = url.searchParams.get('chat') || '';
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });

  try {
    const entries = readAllEntries();
    let turns = buildTurns(entries);

    // Filters
    if (search) {
      turns = turns.filter(t =>
        t.userMessage.toLowerCase().includes(search) ||
        t.summary.toLowerCase().includes(search) ||
        t.finalResponse.toLowerCase().includes(search)
      );
    }
    if (chatType) {
      turns = turns.filter(t => t.chatType === chatType);
    }

    const total = turns.length;
    turns = turns.reverse().slice(offset, offset + limit);

    res.end(JSON.stringify({ total, offset, limit, turns }));
  } catch (err) {
    res.end(JSON.stringify({ error: err.message, turns: [] }));
  }
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"event":"connected"}\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function handleData(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const search = url.searchParams.get('search') || '';
  const agent = url.searchParams.get('agent') || '';
  const eventType = url.searchParams.get('event') || '';
  const limit = parseInt(url.searchParams.get('limit') || '500', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });

  try {
    let lines = readAllEntries();
    const total = lines.length;

    if (search) {
      const lower = search.toLowerCase();
      lines = lines.filter(l => JSON.stringify(l).toLowerCase().includes(lower));
    }
    if (agent) lines = lines.filter(l => l.agentName === agent);
    if (eventType) lines = lines.filter(l => l.event === eventType);

    const filtered = lines.length;
    const page = lines.reverse().slice(offset, offset + limit);

    res.end(JSON.stringify({ total, filtered, offset, limit, entries: page }));
  } catch (err) {
    res.end(JSON.stringify({ error: err.message, entries: [] }));
  }
}

function handleSummary(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  try {
    const entries = readAllEntries();
    const agents = new Set();
    const events = {};
    for (const d of entries) {
      if (d.agentName) agents.add(d.agentName);
      events[d.event] = (events[d.event] || 0) + 1;
    }
    // Count turns
    const turns = buildTurns(entries);

    res.end(JSON.stringify({
      totalLines: entries.length,
      totalTurns: turns.length,
      turnsWithErrors: turns.filter(t => t.hasError).length,
      agents: [...agents].sort(),
      events,
    }));
  } catch (err) {
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ─── Server ────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // API routes
  if (pathname === '/api/events') return handleSSE(req, res);
  if (pathname === '/api/data') return handleData(req, res);
  if (pathname === '/api/summary') return handleSummary(req, res);
  if (pathname === '/api/turns') return handleTurns(req, res);

  // Serve static files
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Bia Dashboard → http://localhost:${PORT}\n`);
});
