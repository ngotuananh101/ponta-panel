import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import test from 'node:test';

const runtime = process.env.PROBE_RUNTIME;
assert.ok(['node', 'workerd'].includes(runtime), 'Use the isolated browser/Go runner.');
const origin = 'http://127.0.0.1:8784';
const publicScript = await readFile(new URL('./browser.mjs', import.meta.url));
const deadline = () => ({ signal: AbortSignal.timeout(5000) });

function start(t, name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  // Register cleanup and observe the rejection even if startup fails before a waiter is installed.
  t.after(async () => { child.kill('SIGKILL'); await exited.catch(() => {}); });
  exited.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  return {
    exited,
    async ready() {
      const [line] = await Promise.race([
        once(lines, 'line', deadline()),
        exited.then(({ code, signal }) => { throw new Error(`${name} stopped before ready (${code ?? signal})`); }),
      ]);
      return line;
    },
  };
}

test(`${runtime}: Chromium and Go exchange binary messages and cannot reopen the retired route`,
  { timeout: 25_000 }, async t => {
    const browserGrant = randomBytes(32).toString('hex');
    const agentGrant = randomBytes(32).toString('hex');
    const args = runtime === 'node' ? ['node-server.mjs'] : ['serve', '--control-fd=1', 'local.capnp'];
    const relay = start(t, 'relay', runtime === 'node' ? process.execPath : '/opt/probe/workerd', args, {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, PROBE_BROWSER_GRANT: browserGrant, PROBE_AGENT_GRANT: agentGrant,
        PROBE_LIFETIME_MS: '18000', PROBE_BROWSER_ORIGIN: origin },
    });
    const ready = JSON.parse(await relay.ready());
    const port = runtime === 'node' ? ready.http : ready.port;
    assert.ok(Number.isInteger(port) && port > 0, 'relay bound to loopback');

    const agent = start(t, 'Go fixture agent', '/opt/probe/agent', [], {
      env: { PROBE_RELAY_PORT: String(port), PROBE_AGENT_GRANT: agentGrant, PROBE_BROWSER_ORIGIN: origin },
    });
    assert.equal(await agent.ready(), 'ready');

    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const policy = `default-src 'none'; script-src 'self'; connect-src 'self' ws://127.0.0.1:${port}`;
    const page = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': policy });
        response.end('<!doctype html><title>Local WebSocket probe</title><script type="module" src="/browser.mjs"></script>');
      } else if (request.method === 'GET' && request.url === '/browser.mjs') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(publicScript);
      } else if (request.method === 'GET' && request.url === '/fixture') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ port, grant: browserGrant }));
      } else if (request.method === 'POST' && request.url === '/result') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
          if (body.length + chunk.length > 32) request.destroy();
          else body += chunk;
        });
        request.once('end', () => { response.writeHead(204).end(); finish(body); });
      } else response.writeHead(404).end();
    });
    t.after(() => new Promise(resolve => { page.close(resolve); page.closeAllConnections(); }));
    page.listen(8784, '127.0.0.1');
    await once(page, 'listening', deadline());
    const browser = start(t, 'Chromium', '/opt/browser/chrome-headless-shell', [
      '--no-sandbox',
      '--disable-background-networking', '--disable-gpu', '--no-proxy-server', '--user-data-dir=/tmp/chromium', origin,
    ], { env: { HOME: '/tmp', XDG_RUNTIME_DIR: '/tmp', LD_LIBRARY_PATH: '/opt/browser-libs' } });
    const result = await Promise.race([
      done,
      browser.exited.then(({ code, signal }) => `browser exited (${code ?? signal})`),
      agent.exited.then(({ code }) => code === 0 ? done : `agent failed (${code})`),
    ]);
    assert.equal(result, 'pass', `Chromium failed at ${result}`);
    assert.deepEqual(await agent.exited, { code: 0, signal: null }, 'Go received, replied, and observed EOF');
  });
