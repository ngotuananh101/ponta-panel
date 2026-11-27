// Disposable policy for one synthetic route, not production authentication.
export const protocol = 'probe.v1';
export const maxMessageBytes = 512;
const maxMessages = 128;

export function createSession({ browserGrant, agentGrant, lifetimeMs, origin = 'https://panel.example.test' }) {
  const grantShape = /^[a-f0-9]{64}$/;
  if (typeof browserGrant !== 'string' || typeof agentGrant !== 'string' ||
      !grantShape.test(browserGrant) || !grantShape.test(agentGrant) || browserGrant === agentGrant ||
      !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 60_000) {
    throw new Error('Invalid synthetic probe configuration');
  }

  const peers = new Map();
  let retired = false;
  let deadline;
  let timer;
  let forwarded = 0;

  function retire() {
    if (retired) return;
    retired = true;
    clearTimeout(timer);
    const attached = [...peers.values()];
    peers.clear();
    for (const peer of attached) {
      try { peer.close(); } catch { /* Already closing or gone; the route remains retired. */ }
    }
  }

  function expired() {
    if (deadline !== undefined && performance.now() >= deadline) retire();
    return retired;
  }

  function authorize({ path, requestOrigin, offered }) {
    if (path !== '/probe') return { status: 404 };
    const [selected, grant, ...extra] = (offered ?? '').split(',').map(value => value.trim());
    if (selected !== protocol || extra.length) return { status: 403 };
    let role;
    if (grant === browserGrant && requestOrigin === origin) role = 'browser';
    if (grant === agentGrant && (requestOrigin === null || requestOrigin === origin)) role = 'agent';
    if (!role) return { status: 403 };
    if (expired()) return { status: 410 };
    if (peers.has(role)) return { status: 409 };
    return { status: 101, role };
  }

  function attach(role, peer) {
    // Both adapters authorize and attach synchronously during the same upgrade.
    peers.set(role, peer);
    if (deadline === undefined) {
      deadline = performance.now() + lifetimeMs;
      timer = setTimeout(retire, lifetimeMs);
    }
    return {
      message(bytes, binary) {
        if (expired()) return;
        const other = peers.get(role === 'browser' ? 'agent' : 'browser');
        if (!binary || bytes.byteLength > maxMessageBytes || !other || forwarded >= maxMessages) {
          retire();
          return;
        }
        forwarded++;
        try { other.send(bytes, retire); } catch { retire(); }
      },
      end: retire,
    };
  }

  return { authorize, attach };
}
