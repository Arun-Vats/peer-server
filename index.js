const { PeerServer } = require('peer');

const port = parseInt(process.env.PORT, 10) || 8000;

const server = PeerServer({
  port,
  path:    '/peerjs',
  proxied: true,
  allow_discovery: false,
});

server.on('connection', (client) => {
  console.log(`[PeerJS] Client connected: ${client.getId()}`);
});

server.on('disconnect', (client) => {
  console.log(`[PeerJS] Client disconnected: ${client.getId()}`);
});

console.log(`[PeerJS] Signal server running on port ${port} at /peerjs`);
