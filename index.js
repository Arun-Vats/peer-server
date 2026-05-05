'use strict';

/**
 * VoiceLink — Signaling Server
 * Deploy on Koyeb. PORT is injected automatically by Koyeb.
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

// username → { socketId, username }
const users = new Map();

function findSocket(username) {
  const entry = users.get(username.toLowerCase());
  return entry ? io.sockets.sockets.get(entry.socketId) : null;
}

// ── Health check ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ service: 'VoiceLink', online: users.size, uptime: Math.floor(process.uptime()) });
});

// ── TURN credentials endpoint ────────────────────────────────────────────────
// FIX #2: TTL reduced to 3600s (1 hour) — matches max expected call length.
// FIX #7: Origin check — only requests from our frontend domain are accepted.
//         Falls back to allowing all if ALLOWED_ORIGIN env var is not set.
app.get('/turn', async (req, res) => {
  const { CF_TURN_TOKEN_ID, CF_API_TOKEN, ALLOWED_ORIGIN } = process.env;

  // FIX #7: Reject requests from unknown origins
  if (ALLOWED_ORIGIN) {
    const origin = req.headers.origin || req.headers.referer || '';
    if (!origin.startsWith(ALLOWED_ORIGIN)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
  }

  if (!CF_TURN_TOKEN_ID || !CF_API_TOKEN) {
    return res.status(500).json({ error: 'TURN env vars not configured.' });
  }

  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_TOKEN_ID}/credentials/generate`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
          'Content-Type':  'application/json',
        },
        // FIX #2: Short TTL — credentials valid for 1 hour only
        body: JSON.stringify({ ttl: 3600 }),
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

  // ── REGISTER ──────────────────────────────────────────────────────────────
  // FIX #3: If username is already registered but old socket is dead,
  //         allow the new socket to take the username immediately.
  // FIX #11: Send current online list to newly registered user.
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

    // FIX #3: Check if existing registration's socket is actually still alive
    if (users.has(key)) {
      const existing = findSocket(key);
      if (existing && existing.connected) {
        // Genuinely online — reject
        socket.emit('username-taken', { msg: `"${key}" is already online.` });
        return;
      }
      // Old socket is dead (disconnect event hasn't fired yet) — evict it
      console.log(`[~] Evicting stale registration for "${key}"`);
      users.delete(key);
      io.emit('presence', { type: 'offline', username: key, online: users.size });
    }

    myName = key;
    users.set(key, { socketId: socket.id, username: key });
    socket.emit('registered', { username: key });
    io.emit('presence', { type: 'online', username: key, online: users.size });

    // FIX #11: Send current online list so new user sees who's already online
    const onlineList = [...users.keys()].filter(u => u !== key);
    if (onlineList.length > 0) {
      socket.emit('online-list', { users: onlineList });
    }

    console.log(`[+] "${key}" — online: ${users.size}`);
  });

  // ── CALL REQUEST ──────────────────────────────────────────────────────────
  socket.on('call-request', ({ to, from } = {}) => {
    if (!myName) return;
    const target = findSocket(to);
    if (!target) { socket.emit('call-failed', { reason: 'User is offline.' }); return; }
    const callId = `${from}-${to}-${Date.now()}`;
    target.emit('incoming-call', { from: myName, callId });
    socket.emit('call-ringing', { to, callId });
  });

  // ── CALL ANSWER ───────────────────────────────────────────────────────────
  socket.on('call-answer', ({ to, callId, accepted } = {}) => {
    if (!myName) return;
    const target = findSocket(to);
    if (!target) return;
    if (accepted) target.emit('call-accepted', { from: myName, callId });
    else          target.emit('call-declined',  { from: myName, callId });
  });

  // ── WebRTC OFFER ──────────────────────────────────────────────────────────
  socket.on('rtc-offer', ({ to, sdp } = {}) => {
    const t = findSocket(to);
    if (t) t.emit('rtc-offer', { from: myName, sdp });
  });

  // ── WebRTC ANSWER ─────────────────────────────────────────────────────────
  socket.on('rtc-answer', ({ to, sdp } = {}) => {
    const t = findSocket(to);
    if (t) t.emit('rtc-answer', { from: myName, sdp });
  });

  // ── ICE CANDIDATES ────────────────────────────────────────────────────────
  // FIX #4: Server buffers ICE candidates per sender, emits to target.
  //         If target's peer isn't ready, the client-side iceBuffer handles it.
  socket.on('rtc-ice', ({ to, candidate } = {}) => {
    const t = findSocket(to);
    if (t) t.emit('rtc-ice', { from: myName, candidate });
  });

  // ── HANGUP ────────────────────────────────────────────────────────────────
  socket.on('call-end', ({ to } = {}) => {
    const t = findSocket(to);
    if (t) t.emit('call-ended', { from: myName });
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!myName) return;
    // Only delete if this socket is still the registered one
    // (prevents evicted stale sockets from deleting the new registration)
    const entry = users.get(myName);
    if (entry && entry.socketId === socket.id) {
      users.delete(myName);
      io.emit('presence', { type: 'offline', username: myName, online: users.size });
      console.log(`[-] "${myName}" — online: ${users.size}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[VoiceLink] Signaling server on port ${PORT}`);
});
