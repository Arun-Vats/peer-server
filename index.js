const { PeerServer } = require('peer');

const port = process.env.PORT || 8000;

PeerServer({
  port,
  path: '/peerjs',
  proxied: true
});