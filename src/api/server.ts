import express from 'express';
import cors from 'cors';
import { biaEvents } from '../utils/events.js';
import { logger } from '../utils/logger.js';
import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import fs from 'fs';

export function initServer() {
  const app = express();
  const PORT = process.env.API_PORT || 3001;

  app.use(cors());
  app.use(express.json());

  app.get('/api/history', (req, res) => {
    const logFile = path.resolve(process.cwd(), 'data/bia_detailed.jsonl');
    if (!fs.existsSync(logFile)) {
      return res.json({ events: [] });
    }

    // Extraímos os logs processando a stream para evitar estouro de memória (maxBuffer)
    const tailProcess = spawn('tail', ['-n', '100000', logFile]);
    const rl = readline.createInterface({
      input: tailProcess.stdout,
      crlfDelay: Infinity
    });

    const events: any[] = [];
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (!event) return;
        if (event.timestamp) {
          const eventDate = new Date(event.timestamp);
          if (eventDate >= tenDaysAgo) {
            events.push(event);
          }
        } else {
           events.push(event);
        }
      } catch (e) {
        // Ignora erro de parsing
      }
    });

    rl.on('close', () => {
      res.json({ events });
    });

    tailProcess.on('error', (err) => {
       console.error('Failed to spawn tail:', err);
       if (!res.headersSent) {
           res.status(500).json({ error: 'Failed to read history' });
       }
    });
  });

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Tell the client that the connection is established
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: new Date().toISOString() })}\n\n`);

    const onLogEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    biaEvents.on('log', onLogEvent);

    req.on('close', () => {
      biaEvents.off('log', onLogEvent);
    });
  });

  app.listen(PORT, () => {
    logger.info(`Bia API Server running on port ${PORT} (SSE available at /api/stream)`);
  });
}
