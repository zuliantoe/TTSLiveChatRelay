import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { TikTokManager, type TikTokEvent } from './tiktok/TikTokManager.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const manager = new TikTokManager();

// Connected clients registry
type WsClient = { socket: WebSocket; room: string };
const wsClientsByRoom = new Map<string, Set<WebSocket>>();
type SseClient = { id: string; write: (chunk: string) => boolean; end: () => void; room: string };
const sseClientsByRoom = new Map<string, Map<string, SseClient>>();

// Broadcast helper
function broadcastEvent(evt: TikTokEvent) {
  const data = JSON.stringify(evt);
  // WS scoped by room
  const wsSet = wsClientsByRoom.get(evt.room);
  if (wsSet) {
    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch {}
      }
    }
  }
  // SSE scoped by room
  const roomClients = sseClientsByRoom.get(evt.room);
  if (roomClients) {
    const ssePayload = `event: ${evt.type}\n` + `data: ${data}\n\n`;
    for (const client of roomClients.values()) {
      try { client.write(ssePayload); } catch {}
    }
  }
}

manager.on('event', (evt: TikTokEvent) => {
  broadcastEvent(evt);
});

// Health
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

// Status
app.get('/status', (_req, res) => {
  res.json({ rooms: manager.getStatus() });
});

// Connect to a TikTok room
app.post('/connect', async (req, res) => {
  const uniqueId = String(req.body?.uniqueId || '').trim();
  if (!uniqueId) return res.status(400).json({ error: 'uniqueId required' });
  try {
    await manager.connect({ uniqueId });
    res.json({ connected: true, uniqueId });
  } catch (err) {
    res.status(500).json({ error: serializeError(err) });
  }
});

// Disconnect from a TikTok room
app.post('/disconnect', async (req, res) => {
  const uniqueId = String(req.body?.uniqueId || '').trim();
  if (!uniqueId) return res.status(400).json({ error: 'uniqueId required' });
  try {
    await manager.disconnect(uniqueId);
    res.json({ disconnected: true, uniqueId });
  } catch (err) {
    res.status(500).json({ error: serializeError(err) });
  }
});

// SSE endpoint per-username: /:username
app.get('/:username', (req, res) => {
  const room = String(req.params.username || '').trim();
  if (!room) return res.status(400).json({ error: 'username required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const write = (chunk: string) => res.write(chunk);
  const end = () => res.end();
  if (!sseClientsByRoom.has(room)) sseClientsByRoom.set(room, new Map());
  sseClientsByRoom.get(room)!.set(clientId, { id: clientId, write, end, room });

  // Send initial comment to open stream
  write(':ok\n\n');

  // Ensure TikTok connection for this room
  void (async () => {
    try {
      await manager.connect({ uniqueId: room });
    } catch (err) {
      try {
        write(
          `event: error\n` +
            `data: ${JSON.stringify({ message: 'connect_failed', detail: serializeError(err) })}\n\n`
        );
      } catch {}
    }
  })();

  req.on('close', () => {
    const roomMap = sseClientsByRoom.get(room);
    if (roomMap) {
      const client = roomMap.get(clientId);
      if (client) {
        try { client.end(); } catch {}
        roomMap.delete(clientId);
      }
      if (roomMap.size === 0) {
        sseClientsByRoom.delete(room);
        const wsSet = wsClientsByRoom.get(room);
        if (!wsSet || wsSet.size === 0) {
          void manager.disconnect(room);
        }
      }
    }
  });
});

// WS endpoint per-username: ws://host/:username
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const room = url.pathname.replace(/^\/+/, '');
  if (!room) {
    ws.close(1008, 'username required in path');
    return;
  }
  if (!wsClientsByRoom.has(room)) wsClientsByRoom.set(room, new Set());
  const set = wsClientsByRoom.get(room)!;
  set.add(ws);

  // Ensure TikTok connection for this room
  void manager.connect({ uniqueId: room }).catch(() => {
    try { ws.close(1011, 'failed to connect to TikTok'); } catch {}
  });
  ws.on('close', () => {
    set.delete(ws);
    if (set.size === 0) {
      wsClientsByRoom.delete(room);
      const sseMap = sseClientsByRoom.get(room);
      if (!sseMap || sseMap.size === 0) {
        void manager.disconnect(room);
      }
    }
  });
});

// Error handling
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}


