#!/usr/bin/env node
import http from 'http';
import { CHAT_PORT, SECURE_COOKIES } from './lib/config.mjs';
import { handleRequest } from './chat/router.mjs';
import { attachWebSocket } from './chat/ws.mjs';
import { killAll } from './chat/session-manager.mjs';

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});

attachWebSocket(server);

function shutdown() {
  console.log('Shutting down chat server...');
  killAll();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(CHAT_PORT, '127.0.0.1', () => {
  console.log(`Chat server listening on http://127.0.0.1:${CHAT_PORT}`);
  console.log(`Cookie mode: ${SECURE_COOKIES ? 'Secure (HTTPS)' : 'Non-secure (localhost)'}`);
});
