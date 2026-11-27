import { createSession, protocol } from './session.mjs';

export default { fetch: (request, env) => env.PROBE_SESSION.getByName('probe').fetch(request) };

export class ProbeSession {
  constructor(_context, env) {
    this.session = createSession({ browserGrant: env.PROBE_BROWSER_GRANT,
      agentGrant: env.PROBE_AGENT_GRANT, lifetimeMs: Number(env.PROBE_LIFETIME_MS),
      origin: env.PROBE_BROWSER_ORIGIN || undefined });
  }

  fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 404 });
    }
    const { status, role } = this.session.authorize({ path: url.pathname + url.search,
      requestOrigin: request.headers.get('origin'), offered: request.headers.get('sec-websocket-protocol') });
    if (status !== 101) return new Response(null, { status });
    const [client, server] = Object.values(new WebSocketPair());
    server.binaryType = 'arraybuffer';
    server.accept();
    const endpoint = this.session.attach(role, { send: bytes => server.send(bytes), close: () => server.close(1000) });
    server.addEventListener('message', event => endpoint.message(event.data, event.data instanceof ArrayBuffer));
    server.addEventListener('close', endpoint.end);
    server.addEventListener('error', endpoint.end);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': protocol } });
  }
}
