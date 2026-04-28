const { PeerServer } = require('peer');

const port = parseInt(process.env.PORT, 10) || 8000;

const server = PeerServer({
  port,
  path:           '/peerjs',
  proxied:        true,
  alive_timeout:  60000,   // 60 s — keep peers registered longer
  expire_timeout: 5000,    // 5 s  — how long to hold messages for offline peers
  concurrent_limit: 5000,  // max simultaneous connections
  allow_discovery: false,  // don't expose peer list publicly
});

server.on('connection', (client) => {
  console.log(`[PeerJS] Client connected: ${client.getId()}`);
});

server.on('disconnect', (client) => {
  console.log(`[PeerJS] Client disconnected: ${client.getId()}`);
});

console.log(`[PeerJS] Signal server running on port ${port} at /peerjs`);
