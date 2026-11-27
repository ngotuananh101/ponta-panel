// In-process feasibility fixture, not an adapter or an authenticated channel.
const providers = new Set(['reverb', 'self-hosted', 'ably', 'pusher', 'apinator']);
const directions = {
  'browser-to-agent': { sender: 'browser', receiver: 'agent' },
  'agent-to-browser': { sender: 'agent', receiver: 'browser' },
};
const frameLimit = 512;
const queueFrameLimit = 4;
const queueByteLimit = 1536;
const reorderWindow = 3;
const gapTimeoutMs = 5000;
const publishWindowMs = 1000;
const publishLimit = 5;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function createRealtimeFixture({ provider, route, epoch, now, lifetimeMs = 60_000 }) {
  if (!providers.has(provider) || typeof route !== 'string' || !/^[a-z0-9-]{1,48}$/.test(route) ||
      !Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1) {
    throw new TypeError('Invalid fixture route or lifetime');
  }
  const expiresAt = now() + lifetimeMs;
  const grants = Object.freeze({ browser: Object.freeze({}), agent: Object.freeze({}) });
  const streams = new Map(Object.entries(directions).map(([direction, roles]) => [direction, {
    ...roles, sendAt: 0, receiveAt: 0, pending: new Map(), ready: [], gapSince: null,
  }]));
  const outbound = [];
  const publishedAt = [];
  let queuedFrames = 0;
  let queuedBytes = 0;
  let reason = null;

  function closeWith(cause) {
    if (reason !== null) return;
    reason = cause;
    outbound.length = 0;
    publishedAt.length = 0;
    for (const stream of streams.values()) {
      stream.pending.clear();
      stream.ready.length = 0;
      stream.gapSince = null;
    }
    queuedFrames = 0;
    queuedBytes = 0;
  }

  function tick(time = now()) {
    if (reason !== null) return;
    if (time >= expiresAt) {
      closeWith('grant-expired');
      return;
    }
    for (const stream of streams.values()) {
      if (stream.gapSince !== null && time - stream.gapSince >= gapTimeoutMs) {
        closeWith('missing-frame');
        return;
      }
    }
  }

  function fits(size) {
    return queuedFrames < queueFrameLimit && queuedBytes + size <= queueByteLimit;
  }

  function charge(size) {
    queuedFrames++;
    queuedBytes += size;
  }

  function release(size) {
    queuedFrames--;
    queuedBytes -= size;
  }

  function publish(grant, direction, payload) {
    const time = now();
    tick(time);
    if (reason !== null) return 'closed';
    const stream = streams.get(direction);
    if (!stream || grants[stream.sender] !== grant) return 'forbidden';
    if (!(payload instanceof Uint8Array)) return 'invalid-payload';
    // Reject obvious oversize input before copying or base64 encoding it.
    if (payload.byteLength > frameLimit * 3 / 4) return 'frame-too-large';
    const wire = Buffer.from(JSON.stringify({
      v: 1, route, direction, epoch, position: stream.sendAt,
      payload: Buffer.from(payload).toString('base64'),
    }));
    if (wire.byteLength > frameLimit) return 'frame-too-large';
    while (publishedAt.length > 0 && time - publishedAt[0] >= publishWindowMs) publishedAt.shift();
    if (publishedAt.length >= publishLimit) return 'rate-limited';
    if (!fits(wire.byteLength)) return 'queue-full';
    outbound.push(wire);
    charge(wire.byteLength);
    publishedAt.push(time);
    stream.sendAt++;
    return 'published';
  }

  function takeOutbound() {
    tick();
    if (reason !== null) return { status: 'closed', reason };
    const wire = outbound.shift();
    if (!wire) return { status: 'empty' };
    release(wire.byteLength);
    return { status: 'data', bytes: wire };
  }

  function reject(cause) {
    closeWith(cause);
    return 'closed';
  }

  // Test driver only: represents delivery by a broker that can drop, duplicate,
  // reorder, or replace opaque frames. It does not authenticate peer bytes.
  function inject(wire) {
    const time = now();
    tick(time);
    if (reason !== null) return 'closed';
    if (!(wire instanceof Uint8Array) || wire.byteLength > frameLimit) return reject('invalid-frame');
    let frame;
    try {
      frame = JSON.parse(utf8.decode(wire));
    } catch {
      return reject('invalid-frame');
    }
    if (!frame || typeof frame !== 'object' || frame.v !== 1 || typeof frame.route !== 'string' ||
        !Number.isSafeInteger(frame.epoch) || frame.epoch < 1) {
      return reject('invalid-frame');
    }
    if (frame.route !== route || frame.epoch !== epoch) return 'ignored';
    const { direction, position, payload } = frame;
    const stream = streams.get(direction);
    if (!stream || !Number.isSafeInteger(position) || position < 0 || typeof payload !== 'string' ||
        Object.keys(frame).length !== 6) {
      return reject('invalid-frame');
    }
    const decoded = Buffer.from(payload, 'base64');
    if (decoded.toString('base64') !== payload) return reject('invalid-frame');
    if (position < stream.receiveAt || stream.pending.has(position)) return 'duplicate';
    if (position - stream.receiveAt > reorderWindow) return reject('reorder-window');
    if (!fits(wire.byteLength)) return reject('receiver-full');
    stream.pending.set(position, { bytes: decoded, size: wire.byteLength });
    charge(wire.byteLength);
    while (stream.pending.has(stream.receiveAt)) {
      stream.ready.push(stream.pending.get(stream.receiveAt));
      stream.pending.delete(stream.receiveAt++);
    }
    stream.gapSince = stream.pending.size === 0 ? null : (stream.gapSince ?? time);
    return 'accepted';
  }

  function read(grant, direction) {
    tick();
    const stream = streams.get(direction);
    if (!stream || grants[stream.receiver] !== grant) return { status: 'forbidden' };
    if (reason !== null) return { status: 'closed', reason };
    const entry = stream.ready.shift();
    if (!entry) return { status: 'empty' };
    release(entry.size);
    return { status: 'data', bytes: entry.bytes };
  }

  return {
    grants, publish, takeOutbound, inject, read,
    close: () => closeWith('closed'),
    tick: () => tick(),
    snapshot() {
      tick();
      return { reason, queuedFrames, queuedBytes };
    },
  };
}
