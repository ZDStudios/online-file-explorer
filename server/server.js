'use strict';

/*
 * Orbit relay server.
 *
 * Brokers messages between two kinds of clients over WebSocket:
 *   - agents : the native helper running on a user's machine (role=agent)
 *   - webs   : the browser client served from GitHub Pages (role=web)
 *
 * A single shared AUTH_TOKEN gates every connection, so only clients that
 * know the secret can ever reach each other. The relay itself never touches
 * the filesystem; it only forwards envelopes. Designed to sit happily inside
 * the Render free tier: no persistence, tiny footprint, one process.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

if (!AUTH_TOKEN) {
  console.warn('[relay] WARNING: AUTH_TOKEN is not set. Set it in the Render dashboard before exposing this service.');
}

// agentId -> { ws, name, platform, connectedAt }
const agents = new Map();
// webId -> ws
const webs = new Map();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function deviceList() {
  return [...agents.entries()].map(([id, a]) => ({
    id,
    name: a.name,
    platform: a.platform,
    connectedAt: a.connectedAt,
  }));
}

function broadcastDevices() {
  const payload = { type: 'devices', devices: deviceList() };
  for (const ws of webs.values()) send(ws, payload);
}

// Minimal HTTP surface: health check for Render + a friendly root page.
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agents: agents.size, webs: webs.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Orbit relay is running. Connect via WebSocket.');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    ws.close(1008, 'bad url');
    return;
  }

  const params = url.searchParams;
  const role = params.get('role');
  const token = params.get('token') || '';

  if (!AUTH_TOKEN || !safeEqual(token, AUTH_TOKEN)) {
    send(ws, { type: 'error', error: 'auth_failed' });
    ws.close(1008, 'auth failed');
    return;
  }

  if (role === 'agent') {
    const id = crypto.randomUUID();
    const name = (params.get('name') || 'Unnamed device').slice(0, 64);
    const platform = (params.get('platform') || 'unknown').slice(0, 32);
    agents.set(id, { ws, name, platform, connectedAt: Date.now() });
    ws.__role = 'agent';
    ws.__id = id;
    console.log(`[relay] agent connected: ${name} (${id})`);
    send(ws, { type: 'registered', id });
    broadcastDevices();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      // Agent responses are addressed back to a specific web client.
      if (msg.to && webs.has(msg.to)) {
        msg.device = id;
        send(webs.get(msg.to), msg);
      }
    });

    ws.on('close', () => {
      agents.delete(id);
      console.log(`[relay] agent disconnected: ${name}`);
      broadcastDevices();
    });
    return;
  }

  if (role === 'web') {
    const id = crypto.randomUUID();
    webs.set(id, ws);
    ws.__role = 'web';
    ws.__id = id;
    console.log(`[relay] web client connected: ${id}`);
    send(ws, { type: 'hello', id });
    send(ws, { type: 'devices', devices: deviceList() });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      // Web requests are addressed to a device (agent).
      const target = agents.get(msg.device);
      if (!target) {
        send(ws, { type: 'resp', reqId: msg.reqId, ok: false, error: 'device_offline' });
        return;
      }
      msg.from = id;
      send(target.ws, msg);
    });

    ws.on('close', () => {
      webs.delete(id);
      console.log(`[relay] web client disconnected: ${id}`);
    });
    return;
  }

  send(ws, { type: 'error', error: 'unknown_role' });
  ws.close(1008, 'unknown role');
});

// Keep sockets alive through Render's idle proxy and prune dead ones.
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.ping(); } catch {}
    }
  }
}, 30000);
wss.on('close', () => clearInterval(interval));

httpServer.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
});
