import { connect } from 'cloudflare:sockets';
import { detectSshBanner } from './banner-reader.mjs';

const TIMEOUT_MS = 5000;
const encoder = new TextEncoder();

function authorized(request, secret) {
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) return false;
  const supplied = request.headers.get('Authorization');
  if (supplied === null || supplied.length !== 71) return false;
  const actual = encoder.encode(supplied);
  const expected = encoder.encode(`Bearer ${secret}`);
  return actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected);
}

async function hasEmptyBody(request) {
  if (request.body === null) return true;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (value.byteLength > 0) return false;
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

function respond(body, status) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/probe' || url.search || !authorized(request, env.PROBE_TOKEN) || !await hasEmptyBody(request)) {
      return respond('not found', 404);
    }

    const target = env.SSH_PROBE_IP;
    if (typeof target !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(target) || target.split('.').some((part) => Number(part) > 255)) {
      return respond('probe not configured', 503);
    }

    let socket;
    let timer;
    try {
      socket = connect({ hostname: target, port: 22 }, { secureTransport: 'off' });
      void socket.closed.catch(() => {});
      const result = await Promise.race([
        socket.opened.then(() => detectSshBanner(socket.readable)),
        new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS); }),
      ]);
      if (result === 'timeout') return respond('SSH banner not confirmed: timeout', 504);
      if (!result) return respond('SSH banner not confirmed: no valid banner', 502);
      return respond('SSH-2.0 banner detected', 200);
    } catch {
      return respond('SSH banner not confirmed: socket error', 502);
    } finally {
      clearTimeout(timer);
      if (socket) void socket.close().catch(() => {});
    }
  },
};
