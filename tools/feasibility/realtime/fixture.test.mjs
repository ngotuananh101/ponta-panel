import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { createRealtimeFixture } from './fixture.mjs';

const outbound = 'browser-to-agent';
const inbound = 'agent-to-browser';
const bytes = (text) => Buffer.from(text);

function setup(overrides = {}) {
  let time = 0;
  const fixture = createRealtimeFixture({
    provider: 'apinator', route: 'rt-7f3a', epoch: 1, now: () => time, ...overrides,
  });
  assert.ok(fixture, 'the realtime fixture must expose a session');
  const { browser, agent } = fixture.grants;
  const send = (text) => fixture.publish(browser, outbound, bytes(text));
  const read = () => fixture.read(agent, outbound).bytes?.toString();
  const take = () => fixture.takeOutbound().bytes ?? null;
  const pump = () => fixture.inject(take());
  return { fixture, browser, agent, send, read, take, pump, advance: (ms) => { time += ms; } };
}

for (const provider of ['reverb', 'self-hosted', 'ably', 'pusher', 'apinator']) {
  test(`${provider}: a shared fixture carries unequal frames in both directions`, () => {
    const { fixture, browser, agent, send, read, pump } = setup({ provider });
    assert.equal(send('hi'), 'published');
    const response = Buffer.from([0, 255, 42, 7, 8]);
    assert.equal(fixture.publish(agent, inbound, response), 'published');
    assert.equal(pump(), 'accepted');
    assert.equal(pump(), 'accepted');
    assert.equal(read(), 'hi');
    assert.deepEqual(fixture.read(browser, inbound), { status: 'data', bytes: response });
    assert.equal(fixture.snapshot().queuedFrames, 0);
  });
}

test('foreign and wrong-direction grants neither publish nor consume data', () => {
  const { fixture, browser, agent, send, pump, read } = setup();
  const foreignGrants = [
    setup({ provider: 'pusher' }), setup({ route: 'rt-other' }), setup({ epoch: 2 }),
  ];
  for (const other of foreignGrants) {
    assert.equal(fixture.publish(other.browser, outbound, bytes('foreign')), 'forbidden');
  }
  assert.equal(fixture.publish(agent, outbound, bytes('wrong direction')), 'forbidden');
  assert.deepEqual(fixture.takeOutbound(), { status: 'empty' });
  assert.equal(send('valid'), 'published');
  assert.equal(fixture.publish(agent, inbound, bytes('reply')), 'published');
  pump();
  pump();
  for (const other of foreignGrants) {
    assert.deepEqual(fixture.read(other.agent, outbound), { status: 'forbidden' });
  }
  assert.deepEqual(fixture.read(browser, outbound), { status: 'forbidden' });
  assert.deepEqual(fixture.read(agent, inbound), { status: 'forbidden' });
  assert.equal(read(), 'valid');
  assert.deepEqual(fixture.read(browser, inbound), { status: 'data', bytes: bytes('reply') });
});

test('both drain methods distinguish an empty queue from a closed session', () => {
  const { fixture, agent, send, pump } = setup();
  assert.deepEqual(fixture.read(agent, outbound), { status: 'empty' });
  assert.deepEqual(fixture.takeOutbound(), { status: 'empty' });
  assert.equal(send('unread'), 'published');
  pump();
  assert.equal(send('unsent'), 'published');
  fixture.close();
  assert.deepEqual(fixture.read(agent, outbound), { status: 'closed', reason: 'closed' });
  assert.deepEqual(fixture.takeOutbound(), { status: 'closed', reason: 'closed' });
});

test('grant expiry retires the fixture even if a frame was already queued', () => {
  const { fixture, send, read, advance } = setup({ lifetimeMs: 100 });
  assert.equal(send('queued'), 'published');
  advance(100);
  assert.equal(send('expired'), 'closed');
  assert.equal(fixture.snapshot().reason, 'grant-expired');
  assert.deepEqual(fixture.takeOutbound(), { status: 'closed', reason: 'grant-expired' });
  assert.equal(read(), undefined);
});

test('the full UTF-8 envelope counts toward the frame limit without spending a position on rejection', () => {
  const { fixture, browser, send, take } = setup();
  assert.equal(fixture.publish(browser, outbound, Buffer.alloc(316)), 'frame-too-large');
  assert.equal(take(), null);
  assert.equal(fixture.publish(browser, outbound, Buffer.alloc(315)), 'published');
  const frame = take();
  assert.equal(frame.byteLength, 512);
  assert.equal(JSON.parse(frame).position, 0);
  assert.equal(send('next'), 'published');
  assert.equal(JSON.parse(take()).position, 1);
});

test('a full sliding publish window rejects writes and reopens after the oldest entry ages out', () => {
  const { fixture, send, take, advance } = setup();
  for (let i = 0; i < 5; i++) {
    assert.equal(send('burst'), 'published');
    assert.equal(JSON.parse(take()).position, i);
  }
  advance(999);
  assert.equal(send('throttled'), 'rate-limited');
  assert.equal(take(), null);
  advance(1);
  assert.equal(send('next'), 'published');
  assert.equal(JSON.parse(take()).position, 5);
  assert.equal(fixture.snapshot().reason, null);
});

test('reordering and duplicates do not alter or repeat the delivered stream', () => {
  const { fixture, send, take, read } = setup();
  const [first, second, third] = ['one', 'two', 'three'].map((text) => {
    assert.equal(send(text), 'published');
    return take();
  });
  assert.equal(fixture.inject(third), 'accepted');
  assert.equal(fixture.inject(third), 'duplicate');
  assert.equal(read(), undefined);
  assert.equal(fixture.inject(first), 'accepted');
  assert.equal(read(), 'one');
  assert.equal(fixture.inject(second), 'accepted');
  assert.equal(read(), 'two');
  assert.equal(read(), 'three');
  assert.equal(fixture.inject(second), 'duplicate');
  assert.equal(read(), undefined);
});

test('a detected gap times out and clears buffered data even if the missing frame arrives later', () => {
  const { fixture, send, take, read, advance } = setup();
  send('missing');
  const late = take();
  send('after gap');
  assert.equal(fixture.inject(take()), 'accepted');
  advance(4999);
  fixture.tick();
  assert.equal(fixture.snapshot().reason, null);
  advance(1);
  fixture.tick();
  assert.deepEqual(fixture.snapshot(), { reason: 'missing-frame', queuedFrames: 0, queuedBytes: 0 });
  assert.equal(fixture.inject(late), 'closed');
  assert.equal(read(), undefined);
});

test('a position outside the reorder window closes rather than buffering an arbitrary jump', () => {
  const { fixture, send, take, read } = setup();
  send('original');
  const frame = JSON.parse(take());
  assert.equal(fixture.inject(bytes(JSON.stringify({ ...frame, position: 4 }))), 'closed');
  assert.equal(fixture.snapshot().reason, 'reorder-window');
  assert.equal(read(), undefined);
});

for (const reason of ['closed', 'grant-expired']) {
  test(`retirement (${reason}) fences both directions on the same route in a new epoch`, () => {
    const { fixture: old, advance } = setup({ provider: 'reverb', lifetimeMs: 100 });
    const { fixture: fresh } = setup({ provider: 'reverb', epoch: 2 });
    const directions = [[outbound, 'browser', 'agent'], [inbound, 'agent', 'browser']];
    assert.equal(old.publish(old.grants.browser, outbound, bytes('received but unread')), 'published');
    assert.equal(old.inject(old.takeOutbound().bytes), 'accepted');
    const delayed = directions.map(([direction, sender]) => {
      assert.equal(old.publish(old.grants[sender], direction, bytes('in transit')), 'published');
      const frame = old.takeOutbound();
      assert.equal(frame.status, 'data');
      return frame.bytes;
    });
    for (const [direction, sender] of directions) {
      assert.equal(old.publish(old.grants[sender], direction, bytes('outbound but unsent')), 'published');
    }
    assert.equal(old.snapshot().queuedFrames, 3);
    if (reason === 'closed') old.close();
    else advance(100);
    assert.deepEqual(old.snapshot(), { reason, queuedFrames: 0, queuedBytes: 0 });
    assert.deepEqual(old.takeOutbound(), { status: 'closed', reason });

    for (const [index, [direction, sender, receiver]] of directions.entries()) {
      const frame = delayed[index];
      assert.equal(old.inject(frame), 'closed');
      assert.deepEqual(old.read(old.grants[receiver], direction), { status: 'closed', reason });
      assert.equal(fresh.inject(frame), 'ignored');
      assert.equal(fresh.publish(old.grants[sender], direction, bytes('old grant')), 'forbidden');
      assert.deepEqual(fresh.read(fresh.grants[receiver], direction), { status: 'empty' });
      const marker = bytes(`new epoch: ${direction}`);
      assert.equal(fresh.publish(fresh.grants[sender], direction, marker), 'published');
      assert.equal(fresh.inject(fresh.takeOutbound().bytes), 'accepted');
      assert.deepEqual(fresh.read(old.grants[receiver], direction), { status: 'forbidden' });
      assert.deepEqual(fresh.read(fresh.grants[receiver], direction), { status: 'data', bytes: marker });
      assert.equal(fresh.inject(frame), 'ignored');
      assert.deepEqual(fresh.read(fresh.grants[receiver], direction), { status: 'empty' });
    }
    assert.deepEqual(fresh.snapshot(), { reason: null, queuedFrames: 0, queuedBytes: 0 });
  });
}

test('an undrained consumer and outbound traffic share one frame budget', () => {
  const { fixture, agent, send, read, pump, take } = setup();
  for (let i = 0; i < 3; i++) {
    assert.equal(send(String(i)), 'published');
    assert.equal(pump(), 'accepted');
  }
  assert.equal(fixture.publish(agent, inbound, bytes('reply')), 'published');
  assert.equal(fixture.snapshot().queuedFrames, 4);
  assert.equal(send('blocked'), 'queue-full');
  assert.equal(read(), '0');
  assert.equal(send('now fits'), 'published');
  assert.equal(JSON.parse(take()).direction, inbound);
  assert.equal(JSON.parse(take()).position, 3);
});

test('the aggregate byte budget can apply before the frame budget', () => {
  const { fixture, browser, take } = setup();
  for (let i = 0; i < 3; i++) assert.equal(fixture.publish(browser, outbound, Buffer.alloc(315)), 'published');
  assert.equal(fixture.snapshot().queuedBytes, 1536);
  assert.equal(fixture.publish(browser, outbound, Buffer.alloc(315)), 'queue-full');
  take();
  assert.equal(fixture.publish(browser, outbound, Buffer.alloc(315)), 'published');
  assert.equal(fixture.snapshot().queuedBytes, 1536);
});

test('injected traffic overflowing a stalled receiver closes and drops all remaining data', () => {
  const { fixture, send, take, read } = setup();
  for (let i = 0; i < 4; i++) {
    assert.equal(send(`queued-${i}`), 'published');
    const frames = take();
    assert.equal(fixture.inject(frames), 'accepted');
    if (i === 3) {
      const next = bytes(JSON.stringify({ ...JSON.parse(frames), position: 4 }));
      assert.equal(fixture.inject(next), 'closed');
    }
  }
  assert.deepEqual(fixture.snapshot(), { reason: 'receiver-full', queuedFrames: 0, queuedBytes: 0 });
  assert.equal(read(), undefined);
});

test('a malformed in-scope frame closes rather than decoding invalid base64 permissively', () => {
  const { fixture, send, take, read } = setup();
  assert.equal(send('valid'), 'published');
  const frame = JSON.parse(take());
  assert.equal(fixture.inject(bytes(JSON.stringify({ ...frame, payload: '____' }))), 'closed');
  assert.equal(fixture.snapshot().reason, 'invalid-frame');
  assert.equal(read(), undefined);
});

test('the relay carries endpoint-produced synthetic ciphertext without the marker or key', () => {
  const { fixture, browser, agent, take } = setup();
  const marker = bytes('PONTA-FIXTURE-MARKER-7f3a');
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const nonce = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(marker), cipher.final(), cipher.getAuthTag()]);
  assert.equal(fixture.publish(browser, outbound, ciphertext), 'published');
  const wire = take();
  assert.equal(take(), null);
  for (const secret of [marker, key]) {
    for (const format of ['hex', 'base64']) assert.equal(wire.includes(secret.toString(format)), false);
    assert.equal(wire.includes(secret), false);
  }
  assert.equal(fixture.inject(wire), 'accepted');
  const result = fixture.read(agent, outbound);
  assert.deepEqual(result, { status: 'data', bytes: ciphertext });
  const received = result.bytes;
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(received.subarray(-16));
  assert.deepEqual(Buffer.concat([decipher.update(received.subarray(0, -16)), decipher.final()]), marker);
});
