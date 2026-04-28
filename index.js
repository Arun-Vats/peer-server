'use strict';

/**
 * PeerJS-compatible signal server
 * Implements the full PeerJS HTTP + WebSocket protocol from scratch.
 * Drop-in replacement for the broken peer@1.0.2 package.
 *
 * Endpoints (PeerJS client expects these):
 *   GET  /peerjs                     → server info JSON
 *   GET  /peerjs/id                  → generate a random peer ID
 *   GET  /peerjs/peers               → list connected peer IDs (disabled)
 *   POST /peerjs/:id/:token/offer    → relay offer   (HTTP fallback)
 *   POST /peerjs/:id/:token/candidate→ relay candidate (HTTP fallback)
 *   POST /peerjs/:id/:token/answer   → relay answer  (HTTP fallback)
 *   POST /peerjs/:id/:token/leave    → relay leave   (HTTP fallback)
 *   WS   /peerjs/peerjs?id=&token=   → primary WebSocket transport
 */

const express = require('express');
const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = parseInt(process.env.PORT, 10) || 8000;
const PATH = '/peerjs';

// ── Message types (mirrors PeerJS protocol) ───────────────────────────────────
const MSG = {
  OPEN:        'OPEN',
  LEAVE:       'LEAVE',
  CANDIDATE:   'CANDIDATE',
  OFFER:       'OFFER',
  ANSWER:      'ANSWER',
  EXPIRE:      'EXPIRE',
  ERROR:       'ERROR',
  ID_TAKEN:    'ID-TAKEN',
  HTTP_ERROR:  'HTTP-ERROR',
  HEARTBEAT:   'HEARTBEAT',
};

// ── Peer registry ─────────────────────────────────────────────────────────────
// Map<id, { id, token, socket, queue: Message[], lastSeen: Date }>
const peers = new Map();

function getPeer(id)          { return peers.get(id); }
function hasPeer(id)          { return peers.has(id); }
function removePeer(id)       { peers.delete(id); }

function send(socket, msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(msg)); } catch (_) {}
  }
}

function transmit(id, msg) {
  const peer = getPeer(id);
  if (!peer) return false;
  if (peer.socket && peer.socket.readyState === WebSocket.OPEN) {
    send(peer.socket, msg);
  } else {
    // Queue for HTTP polling fallback (PeerJS retries via HTTP if WS isn't up)
    if (peer.queue.length < 100) peer.queue.push(msg);
  }
  return true;
}

// ── Express app ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.set('trust proxy', true);
app.use(express.json());

// CORS — allow any origin (Netlify, localhost, etc.)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Server info
app.get(PATH, (req, res) => {
  res.json({ name: 'PeerJS Server', description: 'Signal server', website: '' });
});

// Generate a random peer ID
app.get(`${PATH}/id`, (req, res) => {
  res.send(uuidv4());
});

// Peer list — disabled for privacy
app.get(`${PATH}/peers`, (req, res) => {
  res.json([]);
});

// HTTP relay fallback (PeerJS uses this when WebSocket isn't established yet)
['offer', 'candidate', 'answer', 'leave'].forEach(type => {
  app.post(`${PATH}/:id/:token/${type}`, (req, res) => {
    const { id, token } = req.params;
    const peer = getPeer(id);

    if (!peer || peer.token !== token) {
      return res.status(401).json({ error: 'Invalid id/token' });
    }

    const dst = req.body?.dst;
    if (!dst) return res.status(400).json({ error: 'dst required' });

    const delivered = transmit(dst, {
      type:    type.toUpperCase(),
      src:     id,
      dst,
      payload: req.body,
    });

    if (!delivered) {
      // Destination not found — queue an EXPIRE back to sender
      transmit(id, { type: MSG.EXPIRE, src: dst });
    }

    res.sendStatus(200);
  });
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: `${PATH}/peerjs` });

wss.on('connection', (socket, req) => {
  const url    = new URL(req.url, `http://${req.headers.host}`);
  const id     = url.searchParams.get('id');
  const token  = url.searchParams.get('token');
  const version= url.searchParams.get('version') || 'unknown';

  if (!id || !token) {
    send(socket, { type: MSG.ERROR, payload: { msg: 'No id or token supplied' } });
    socket.close();
    return;
  }

  if (hasPeer(id)) {
    // ID already registered
    send(socket, { type: MSG.ID_TAKEN, payload: { msg: 'ID is taken' } });
    socket.close();
    return;
  }

  // Register peer
  const peer = { id, token, socket, queue: [], lastSeen: new Date() };
  peers.set(id, peer);
  console.log(`[+] ${id} connected (PeerJS v${version}) — total: ${peers.size}`);

  // Send OPEN acknowledgement
  send(socket, { type: MSG.OPEN });

  // Flush any queued messages (from HTTP fallback)
  if (peer.queue.length > 0) {
    peer.queue.forEach(msg => send(socket, msg));
    peer.queue = [];
  }

  // ── Incoming messages ──
  socket.on('message', raw => {
    peer.lastSeen = new Date();
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    switch (msg.type) {
      case MSG.HEARTBEAT:
        // Just update lastSeen — no reply needed
        break;

      case MSG.OFFER:
      case MSG.ANSWER:
      case MSG.CANDIDATE:
      case MSG.LEAVE: {
        const dst = msg.dst;
        if (!dst) break;
        const delivered = transmit(dst, { ...msg, src: id });
        if (!delivered && msg.type !== MSG.LEAVE) {
          transmit(id, { type: MSG.EXPIRE, src: dst });
        }
        break;
      }

      default:
        console.warn(`[?] Unknown message type from ${id}:`, msg.type);
    }
  });

  // ── Disconnect ──
  socket.on('close', () => {
    console.log(`[-] ${id} disconnected — total: ${peers.size - 1}`);
    removePeer(id);
  });

  socket.on('error', err => {
    console.error(`[!] Socket error for ${id}:`, err.message);
    removePeer(id);
  });
});

// ── Heartbeat watchdog — remove stale peers every 5 s ────────────────────────
setInterval(() => {
  const now     = Date.now();
  const timeout = 10_000; // 10 s without any message = stale (client reconnects after 12s)
  for (const [id, peer] of peers) {
    if (now - peer.lastSeen.getTime() > timeout) {
      console.log(`[~] Evicting stale peer: ${id}`);
      try { peer.socket.terminate(); } catch (_) {}
      removePeer(id);
    }
  }
}, 5_000);

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[PeerJS] Signal server running on port ${PORT} at ${PATH}`);
  console.log(`[PeerJS] WebSocket endpoint: ws://...${PATH}/peerjs`);
});
