import { createServer, STATUS_CODES } from 'node:http';
import { createRequire } from 'node:module';
import { createSession, maxMessageBytes, protocol } from './session.mjs';

const { WebSocketServer } = createRequire(import.meta.url)(process.env.PROBE_WS_MODULE);
const session = createSession({ browserGrant: process.env.PROBE_BROWSER_GRANT,
  agentGrant: process.env.PROBE_AGENT_GRANT, lifetimeMs: Number(process.env.PROBE_LIFETIME_MS),
  origin: process.env.PROBE_BROWSER_ORIGIN || undefined });
const sockets = new WebSocketServer({ noServer: true, clientTracking: false,
  maxPayload: maxMessageBytes, perMessageDeflate: false, handleProtocols: () => protocol });
const server = createServer((_, response) => response.writeHead(404).end());

server.on('upgrade', (request, socket, head) => {
  const { status, role } = session.authorize({ path: request.url,
    requestOrigin: request.headers.origin ?? null, offered: request.headers['sec-websocket-protocol'] });
  if (status !== 101) {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  sockets.handleUpgrade(request, socket, head, ws => {
    const endpoint = session.attach(role, {
      send(bytes, fail) { ws.send(bytes, { binary: true }, error => { if (error) fail(); }); },
      close() { ws.close(1000); },
    });
    ws.on('message', endpoint.message);
    ws.once('close', endpoint.end);
    ws.on('error', endpoint.end);
  });
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ http: server.address().port })));
