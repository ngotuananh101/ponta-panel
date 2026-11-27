import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Substitute only the Cloudflare runtime APIs; no sockets are opened.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:sockets') {
      return {
        url: 'data:text/javascript,export const connect = (...args) => globalThis.__connectSshProbe(...args);',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { default: worker } = await import('./banner-worker.mjs');
hooks.deregister();
if (!('timingSafeEqual' in crypto.subtle)) {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', { value: timingSafeEqual });
}

const env = { SSH_PROBE_IP: '203.0.113.7', PROBE_TOKEN: 'a'.repeat(64) };
const endpoint = 'https://probe.invalid/probe';
const headers = { Authorization: `Bearer ${env.PROBE_TOKEN}` };

async function invokeFixture({ url = endpoint, init = { method: 'POST', headers }, bindings = env, fail = false } = {}) {
  const dials = [];
  let closes = 0;
  globalThis.__connectSshProbe = (...args) => {
    dials.push(args);
    return {
      opened: fail ? Promise.reject(new Error('synthetic socket error')) : Promise.resolve(),
      closed: Promise.resolve(),
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('SSH-2.0-fixture\r\n'));
          controller.close();
        },
      }),
      get writable() { assert.fail('the probe must not access the socket writable stream'); },
      async close() { closes++; },
    };
  };
  try {
    const response = await worker.fetch(new Request(url, init), bindings);
    return { status: response.status, text: await response.text(), dials, closes };
  } finally {
    delete globalThis.__connectSshProbe;
  }
}

test('refuses unauthenticated requests and request-supplied targets before dialing', async () => {
  for (const input of [
    { init: { method: 'POST' } },
    { init: { method: 'POST', headers: { Authorization: `Bearer ${'b'.repeat(64)}` } } },
    { init: { method: 'GET', headers } },
    { url: `${endpoint}?hostname=example.invalid` },
    { init: { method: 'POST', headers, body: 'example.invalid' } },
  ]) {
    assert.deepEqual(await invokeFixture(input), { status: 404, text: 'not found', dials: [], closes: 0 });
  }
});

test('dials only the configured IPv4 address on port 22, reads, and closes', async () => {
  assert.deepEqual(await invokeFixture(), {
    status: 200,
    text: 'SSH-2.0 banner detected',
    dials: [[{ hostname: env.SSH_PROBE_IP, port: 22 }, { secureTransport: 'off' }]],
    closes: 1,
  });
});

test('accepts a zero-length body represented as a stream', async () => {
  const result = await invokeFixture({ init: {
    method: 'POST', headers, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.close(); } }),
  } });
  assert.equal(result.status, 200);
  assert.equal(result.dials.length, 1);
  assert.equal(result.closes, 1);
});

test('rejects non-IP configuration and closes on socket error without returning its details', async () => {
  assert.deepEqual(await invokeFixture({ bindings: { ...env, SSH_PROBE_IP: 'example.invalid' } }), {
    status: 503, text: 'probe not configured', dials: [], closes: 0,
  });
  const result = await invokeFixture({ fail: true });
  assert.equal(result.status, 502);
  assert.equal(result.text, 'SSH banner not confirmed: socket error');
  assert.equal(result.closes, 1);
});
