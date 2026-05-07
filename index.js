'use strict';

/**
 * VoiceLink — 1:1 Room Signaling Server
 *
 * Architecture:
 *   - No usernames, no presence, no contacts
 *   - Two peers join the same room ID → auto-connect
 *   - Room holds max 2 peers, 3rd person gets rejected
 *   - Rooms are ephemeral — destroyed when both peers leave
 *   - Designed to be embedded into any SaaS via URL param
 *
 * Usage:
 *   https://your-frontend.com/?room=ROOM_ID
 *
 * Deploy on Koyeb. PORT injected automatically.
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');

const PORT = parseInt(process.env.PORT, 10) || 8000;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:          { origin: '*', methods: ['GET', 'POST'] },
  pingInterval:  10_000,
  pingTimeout:   20_000,
  maxHttpBufferSize: 1e6, // 1MB max message size
});

// roomId → Set of socketIds (max 2)
const rooms = new Map();

function getRoomPeer(roomId, excludeSocketId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  for (const id of room) {
    if (id !== excludeSocketId) {
      return io.sockets.sockets.get(id) || null;
    }
  }
  return null;
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    service: 'VoiceLink',
    rooms:   rooms.size,
    uptime:  Math.floor(process.uptime()),
  });
});

// ── TURN credentials ──────────────────────────────────────────────────────────
// TTL: 3600s (1 hour) — sufficient for any call
// Origin check: set ALLOWED_ORIGIN env var to your frontend domain
app.get('/turn', async (req, res) => {
  const { CF_TURN_TOKEN_ID, CF_API_TOKEN, ALLOWED_ORIGIN } = process.env;

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

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let myRoom = null;

  // ── JOIN ROOM ──────────────────────────────────────────────────────────────
  // Client sends: { roomId: string }
  // Server replies:
  //   'room-joined'  { role: 'initiator' | 'responder', roomId }
  //   'room-full'    { msg }
  //   'room-invalid' { msg }
  socket.on('join-room', ({ roomId } = {}) => {
    if (!roomId || typeof roomId !== 'string') {
      socket.emit('room-invalid', { msg: 'Invalid room ID.' });
      return;
    }

    const key = roomId.trim().toLowerCase().slice(0, 64);
    if (!/^[a-z0-9_-]+$/.test(key)) {
      socket.emit('room-invalid', { msg: 'Room ID must be letters, numbers, - or _' });
      return;
    }

    if (!rooms.has(key)) {
      rooms.set(key, new Set());
    }

    const room = rooms.get(key);

    // Clean dead sockets from room before checking size
    for (const id of room) {
      if (!io.sockets.sockets.has(id)) room.delete(id);
    }

    if (room.size >= 2) {
      socket.emit('room-full', { msg: 'Room is full. Max 2 participants.' });
      return;
    }

    // First person in room = initiator (will send the offer)
    // Second person = responder (will send the answer)
    const role = room.size === 0 ? 'initiator' : 'responder';

    room.add(socket.id);
    myRoom = key;

    socket.emit('room-joined', { role, roomId: key });
    console.log(`[+] Socket ${socket.id} joined room "${key}" as ${role} — peers: ${room.size}`);

    // If second peer just joined, tell the first peer to start WebRTC
    if (role === 'responder') {
      const peer = getRoomPeer(key, socket.id);
      if (peer) peer.emit('peer-joined');
    }
  });

  // ── WebRTC OFFER ──────────────────────────────────────────────────────────
  socket.on('rtc-offer', ({ sdp } = {}) => {
    if (!myRoom) return;
    const peer = getRoomPeer(myRoom, socket.id);
    if (peer) peer.emit('rtc-offer', { sdp });
  });

  // ── WebRTC ANSWER ─────────────────────────────────────────────────────────
  socket.on('rtc-answer', ({ sdp } = {}) => {
    if (!myRoom) return;
    const peer = getRoomPeer(myRoom, socket.id);
    if (peer) peer.emit('rtc-answer', { sdp });
  });

  // ── ICE CANDIDATES ────────────────────────────────────────────────────────
  socket.on('rtc-ice', ({ candidate } = {}) => {
    if (!myRoom) return;
    const peer = getRoomPeer(myRoom, socket.id);
    if (peer) peer.emit('rtc-ice', { candidate });
  });

  // ── HANGUP ────────────────────────────────────────────────────────────────
  socket.on('leave-room', () => {
    handleLeave();
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    handleLeave();
  });

  function handleLeave() {
    if (!myRoom) return;
    const room = rooms.get(myRoom);
    if (room) {
      room.delete(socket.id);
      // Notify the other peer
      const peer = getRoomPeer(myRoom, socket.id);
      if (peer) peer.emit('peer-left');
      // Destroy empty room
      if (room.size === 0) {
        rooms.delete(myRoom);
        console.log(`[x] Room "${myRoom}" destroyed.`);
      }
    }
    console.log(`[-] Socket ${socket.id} left room "${myRoom}"`);
    myRoom = null;
  }
});

server.listen(PORT, () => {
  console.log(`[VoiceLink] Room signaling server on port ${PORT}`);
});
