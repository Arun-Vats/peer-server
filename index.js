'use strict';

/**
 * VoiceLink — Signaling Server
 * Deploy on Koyeb. PORT is injected automatically by Koyeb.
 *
 * Handles:
 *   - Username registration & uniqueness
 *   - Online presence broadcast
 *   - Call routing (request / answer / decline)
 *   - WebRTC offer / answer / ICE forwarding
 *   - Hangup signaling
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');

const PORT = parseInt(process.env.PORT, 10) || 8000;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10_000,
  pingTimeout:  20_000,
});

// username (lowercase) → { socketId, username }
const users = new Map();

function findSocket(username) {
  const entry = users.get(username.toLowerCase());
  return entry ? io.sockets.sockets.get(entry.socketId) : null;
}

// Health check
app.get('/', (_req, res) => {
  res.json({ service: 'VoiceLink', online: users.size, uptime: Math.floor(process.uptime()) });
});

// TURN credentials endpoint — replaces Netlify function
app.get('/turn', async (_req, res) => {
  const { CF_TURN_TOKEN_ID, CF_API_TOKEN } = process.env;
  if (!CF_TURN_TOKEN_ID || !CF_API_TOKEN) {
    return res.status(500).json({ error: 'TURN env vars not configured on server.' });
  }
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_TOKEN_ID}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      }
    );
    if (!r.ok) {
      const txt = await r.text();
      console.error('[TURN]', r.status, txt);
      return res.status(502).json({ error: 'Cloudflare TURN request failed.' });
    }
    const data = await r.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (e) {
    console.error('[TURN] Exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

io.on('connection', socket => {
  let myName = null;

  // ── REGISTER ────────────────────────────────────────────────────────────────
  socket.on('register', ({ username } = {}) => {
    if (!username || typeof username !== 'string') {
      socket.emit('username-invalid', { msg: 'Username must be a non-empty string.' });
      return;
    }
    const key = username.toLowerCase().trim();
    if (!/^[a-z0-9._-]{2,24}$/.test(key)) {
      socket.emit('username-invalid', { msg: '2–24 chars: letters, numbers, _ . -' });
      return;
    }
    if (users.has(key)) {
      socket.emit('username-taken', { msg: `"${key}" is already online.` });
      return;
    }
    myName = key;
    users.set(key, { socketId: socket.id, username: key });
    socket.emit('registered', { username: key });
    io.emit('presence', { type: 'online', username: key, online: users.size });
    console.log(`[+] "${key}" — online: ${users.size}`);
  });

  // ── CALL REQUEST (caller → callee) ─────────────────────────────────────────
  socket.on('call-request', ({ to, from } = {}) => {
    if (!myName) return;
    const target = findSocket(to);
    if (!target) { socket.emit('call-failed', { reason: 'User is offline.' }); return; }
    const callId = `${from}-${to}-${Date.now()}`;
    target.emit('incoming-call', { from: myName, callId });
    socket.emit('call-ringing', { to, callId });
  });

  // ── CALL ANSWER (callee → caller) ──────────────────────────────────────────
  socket.on('call-answer', ({ to, callId, accepted } = {}) => {
    if (!myName) return;
    const target = findSocket(to);
    if (!target) return;
    if (accepted) target.emit('call-accepted', { from: myName, callId });
    else          target.emit('call-declined',  { from: myName, callId });
  });

  // ── WebRTC OFFER ───────────────────────────────────────────────────────────
  socket.on('rtc-offer', ({ to, sdp } = {}) => {
    const t = findSocket(to);
    if (t) t.emit('rtc-offer', { from: myName, sdp });
  });

  // ── WebRTC ANSWER ──────────────────────────────────────────────────────────
  socket.on('rtc-answer', ({ to, sdp } = {}) => {
    const t = findSocket(to);
    if (t) t.emit('rtc-answer', { from: myName, sdp });
  });

  // ── ICE CANDIDATES ─────────────────────────────────────────────────────────
  socket.on('rtc-ice', ({ to, candidate } = {}) => {
    const t = findSocket(to);
    if (t) t.emit('rtc-ice', { from: myName, candidate });
  });

  // ── HANGUP ─────────────────────────────────────────────────────────────────
  socket.on('call-end', ({ to } = {}) => {
    const t = findSocket(to);
    if (t) t.emit('call-ended', { from: myName });
  });

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!myName) return;
    users.delete(myName);
    io.emit('presence', { type: 'offline', username: myName, online: users.size });
    console.log(`[-] "${myName}" — online: ${users.size}`);
  });
});

server.listen(PORT, () => {
  console.log(`[VoiceLink] Signaling server on port ${PORT}`);
});
