import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import test from 'node:test';

const runtime = process.env.PROBE_RUNTIME;
if (!['node', 'workerd'].includes(runtime) || !process.env.PROBE_WS_MODULE) {
  throw new Error('Set PROBE_RUNTIME and an absolute PROBE_WS_MODULE; run inside the isolated container.');
}
const WebSocket = createRequire(import.meta.url)(process.env.PROBE_WS_MODULE);
const origin = 'https://panel.example.test';
const protocol = 'probe.v1';
const within = () => ({ signal: AbortSignal.timeout(3000) });

async function start(t, lifetime = 20_000) {
  const browserGrant = randomBytes(32).toString('hex');
  const agentGrant = randomBytes(32).toString('hex');
  const here = new URL('.', import.meta.url);
  const command = runtime === 'node' ? process.execPath : process.env.PROBE_WORKERD;
  const args = runtime === 'node' ? ['node-server.mjs'] : ['serve', '--control-fd=1', 'local.capnp'];
  const child = spawn(command, args, {
    cwd: here,
    env: { ...process.env, PROBE_BROWSER_GRANT: browserGrant, PROBE_AGENT_GRANT: agentGrant,
      PROBE_LIFETIME_MS: String(lifetime) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const ended = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  const lines = createInterface({ input: child.stdout });
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    lines.close();
    child.kill('SIGKILL');
    await ended;
  });
  const [line] = await Promise.race([
    once(lines, 'line', within()),
    ended.then(() => { throw new Error(`${runtime} stopped before reporting a port`); }),
  ]);
  const ready = JSON.parse(line);
  const port = runtime === 'node' ? ready.http : ready.port;
  assert.ok(Number.isInteger(port) && port > 0, `runner reports a bound loopback port: ${line}`);

  function dial({ grant = browserGrant, from = origin, path = '/probe', offer = protocol } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, [offer, grant],
      { origin: from ?? undefined, handshakeTimeout: 2000 });
    clients.push(ws);
    ws.on('error', () => {}); // Rejection and cleanup may emit an error after a test stops waiting.
    return ws;
  }
  const open = async (role) => {
    const ws = dial(role === 'agent' ? { grant: agentGrant, from: null } : {});
    await once(ws, 'open', within());
    assert.equal(ws.protocol, protocol, 'the server negotiates the fixed protocol, never the grant');
    return ws;
  };
  return { dial, open, agentGrant, browserGrant };
}

async function rejected(ws, expected) {
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('upgrade did not terminate')), 2500);
    const done = value => { clearTimeout(timeout); resolve(value); };
    ws.once('unexpected-response', (request, response) => {
      response.resume();
      request.destroy();
      done(response.statusCode);
    });
    ws.once('open', () => done(101));
    ws.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  assert.equal(status, expected);
}

async function sendBytes(from, to, bytes) {
  const message = once(to, 'message', within());
  from.send(bytes);
  const [body, binary] = await message;
  assert.equal(binary, true);
  assert.deepEqual(body, bytes);
}

const check = (name, fn) => test(`${runtime}: ${name}`, { timeout: 9000 }, fn);

check('forwards distinct binary messages in both directions', async t => {
  const { open } = await start(t);
  const browser = await open('browser');
  const agent = await open('agent');
  await sendBytes(browser, agent, Buffer.from([0, 128, 255]));
  await sendBytes(agent, browser, Buffer.alloc(512, 173));
});

check('rejects bad grants, origins, paths and duplicate roles without disturbing the pair', async t => {
  const { dial, open, agentGrant } = await start(t);
  await rejected(dial({ grant: 'invalid' }), 403);
  await rejected(dial({ from: null }), 403);
  await rejected(dial({ from: 'https://other.example.test' }), 403);
  await rejected(dial({ grant: agentGrant, from: 'https://other.example.test' }), 403);
  await rejected(dial({ offer: 'other' }), 403);
  await rejected(dial({ path: '/probe?extra=1' }), 404);
  const browser = await open('browser');
  const agent = await open('agent');
  await rejected(dial(), 409);
  await rejected(dial({ grant: agentGrant, from: null }), 409);
  await sendBytes(browser, agent, Buffer.from([47]));
});

for (const [name, invalid] of [['text', 'fixture text'], ['oversize binary', Buffer.alloc(513)]]) {
  check(`closes both peers on ${name} instead of forwarding it`, async t => {
    const { dial, open } = await start(t);
    const browser = await open('browser');
    const agent = await open('agent');
    let delivered = 0;
    agent.on('message', () => delivered++);
    const closed = Promise.all([once(browser, 'close', within()), once(agent, 'close', within())]);
    browser.send(invalid);
    await closed;
    assert.equal(delivered, 0);
    await rejected(dial(), 410);
  });
}

check('closes both peers before forwarding message 129 across the duplex budget', async t => {
  const { open } = await start(t);
  const browser = await open('browser');
  const agent = await open('agent');
  for (let i = 0; i < 64; i++) {
    await sendBytes(browser, agent, Buffer.from([i]));
    await sendBytes(agent, browser, Buffer.from([255 - i]));
  }
  let delivered = 0;
  agent.on('message', () => delivered++);
  const closed = Promise.all([once(browser, 'close', within()), once(agent, 'close', within())]);
  browser.send(Buffer.from([128]));
  await closed;
  assert.equal(delivered, 0);
});

check('retirement after peer close rejects both old grants instead of replacing a peer', async t => {
  const { dial, open, agentGrant } = await start(t);
  const browser = await open('browser');
  const agent = await open('agent');
  const closed = once(agent, 'close', within());
  browser.close(1000);
  await closed;
  await rejected(dial(), 410);
  await rejected(dial({ grant: agentGrant, from: null }), 410);
});

check('an unpaired socket expires and cannot reopen the old session', async t => {
  const { dial, open, agentGrant } = await start(t, 600);
  const browser = await open('browser');
  await once(browser, 'close', within());
  await rejected(dial({ grant: agentGrant, from: null }), 410);
});

check('a frame with no receiver retires the route instead of queuing a replay', async t => {
  const { dial, open, agentGrant } = await start(t);
  const browser = await open('browser');
  const closed = once(browser, 'close', within());
  browser.send(Buffer.from([91]));
  await closed;
  await rejected(dial({ grant: agentGrant, from: null }), 410);
});
