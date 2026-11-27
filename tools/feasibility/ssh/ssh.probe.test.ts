/**
 * Local feasibility contract for the Task 1 SSH probe.
 *
 * Runner deviation (controller-enforced): the controller for this task
 * restricted work to strictly local tooling with no dependency fetching, so the
 * brief's `pnpm exec vitest run tools/feasibility/ssh/ssh.probe.test.ts` was
 * replaced with the built-in Node test runner. In this worktree Vitest is not
 * installable without fetching/installing dependencies, and pnpm 12
 * auto-installs on `exec`; both are outside the boundaries the controller set.
 * This is a deviation from the brief under controller direction, not something
 * the original brief authorized. The tests use `node:test` and
 * `node:assert/strict` with no third-party dependency. The brief's `expect(...)`
 * assertions map one-to-one:
 *   expect(x).toBe(y)        -> assert.equal(x, y)
 *   expect(x).toBe(true)     -> assert.equal(x, true) / assert.ok(x)
 *   expect(s).toMatch(re)    -> assert.match(s, re)
 *   expect(n).toBeGreaterThan(m) -> assert.ok(n > m)
 *   expect(s).not.toContain(t)   -> assert.equal(s.includes(t), false)
 *   expect(fn).toThrow(re)   -> assert.throws(fn, re)
 *
 * These tests use only the in-process fixture transport in `worker.ts`. They
 * prove ordering and fallback behavior against fixed synthetic endpoints; they
 * cannot prove a real Cloudflare Worker outbound-TCP dial, a browser SSH
 * implementation, or a real SSH server. Those gates are recorded as blocked in
 * the task report.
 *
 * Fingerprint fixtures are deliberately two separate sources:
 *   - `CLIENT_EXPECTED_PINS` below is the client-side pin, declared here and
 *     never imported from the simulated server.
 *   - `FIXTURE_ENDPOINTS[*].presentedFingerprint` in `worker.ts` is the
 *     identity the simulated server presents.
 * The success tests compare the two, so they must agree by value, not by
 * construction. A regression test changes only the presented identity and checks
 * that the previously accepted client pin still fails closed.
 *
 * `probe.ts` is imported without a fallback so the first run is red on the
 * missing implementation rather than on missing fixture setup.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { probeSsh } from './probe.ts';
import {
  FIXTURE_CREDENTIALS,
  FIXTURE_ENDPOINTS,
  FIXTURE_MARKER,
  FixtureWorker,
} from './worker.ts';

/**
 * Client-side expected pins. These are the values a browser/known-host record
 * would hold. They are declared independently of the simulated server and must
 * match its presented identity by value for the success cases.
 */
const CLIENT_EXPECTED_PINS = Object.freeze({
  authorized:
    'SHA256:pontaFixtureAuthorizedEd25519Synthetic000000000000000000',
  approvedUnreachable:
    'SHA256:pontaFixtureUnreachableEd25519Synthetic0000000000000000000',
});

/** A server-presented identity that no client pin ever accepted. */
const ROTATED_PRESENTED_FINGERPRINT =
  'SHA256:pontaFixtureRotatedEd25519Synthetic000000000000000000000000';

const AUTHORIZED_TARGET = `${FIXTURE_ENDPOINTS.authorized.host}:${FIXTURE_ENDPOINTS.authorized.port}`;
const UNREACHABLE_TARGET = `${FIXTURE_ENDPOINTS.approvedUnreachable.host}:${FIXTURE_ENDPOINTS.approvedUnreachable.port}`;
// TEST-NET-2, deliberately outside the fixture allowlist.
const UNAUTHORIZED_TARGET = '198.51.100.23:22';

const ALL_FIXTURE_SECRETS = [
  FIXTURE_CREDENTIALS.username,
  FIXTURE_CREDENTIALS.password,
  FIXTURE_CREDENTIALS.privateKey,
  FIXTURE_CREDENTIALS.encryptedPrivateKey,
  FIXTURE_CREDENTIALS.privateKeyPassphrase,
];

describe('fixture SSH probe contract', () => {
  test('wrong host fingerprint makes zero authentication attempts', async () => {
    const wrongFingerprint = await probeSsh({
      target: AUTHORIZED_TARGET,
      expectedFingerprint:
        'SHA256:pontaFixtureWrongFingerprintSynthetic00000000000000000000000',
      auth: {
        method: 'password',
        username: FIXTURE_CREDENTIALS.username,
        password: FIXTURE_CREDENTIALS.password,
      },
    });

    assert.equal(wrongFingerprint.hostVerified, false);
    assert.equal(wrongFingerprint.outcome, 'host-key-mismatch');
    // Brief: expect(wrongFingerprint.authAttempts).toBe(0)
    assert.equal(wrongFingerprint.authAttempts, 0);
    assert.equal(wrongFingerprint.authentication.ok, false);
    assert.equal(wrongFingerprint.markerRead, false);
    assert.equal(wrongFingerprint.fallback.kind, 'manual-install');
  });

  test('the independent client pin matches the fixture presented identity by value', () => {
    // These are two separate declarations. They agree by value today; this
    // check fails loudly if either source drifts, instead of the success test
    // silently pinning a server-supplied value against itself.
    assert.equal(
      CLIENT_EXPECTED_PINS.authorized,
      FIXTURE_ENDPOINTS.authorized.presentedFingerprint,
    );
    assert.equal(
      CLIENT_EXPECTED_PINS.approvedUnreachable,
      FIXTURE_ENDPOINTS.approvedUnreachable.presentedFingerprint,
    );
    assert.notEqual(CLIENT_EXPECTED_PINS.authorized, ROTATED_PRESENTED_FINGERPRINT);
  });

  test('a changed presented identity fails closed with zero auth attempts using the same accepted pin', async () => {
    // Simulate only the server side rotating or an impersonated host key. The
    // client keeps the pin it previously accepted; no credential is offered.
    const impersonated = new FixtureWorker({
      presentedFingerprints: {
        authorized: ROTATED_PRESENTED_FINGERPRINT,
      },
    });

    const acceptedBefore = await probeSsh(
      {
        target: AUTHORIZED_TARGET,
        expectedFingerprint: CLIENT_EXPECTED_PINS.authorized,
        auth: {
          method: 'password',
          username: FIXTURE_CREDENTIALS.username,
          password: FIXTURE_CREDENTIALS.password,
        },
      },
      new FixtureWorker(),
    );
    assert.equal(acceptedBefore.outcome, 'authenticated');

    const changed = await probeSsh(
      {
        target: AUTHORIZED_TARGET,
        expectedFingerprint: CLIENT_EXPECTED_PINS.authorized,
        auth: {
          method: 'password',
          username: FIXTURE_CREDENTIALS.username,
          password: FIXTURE_CREDENTIALS.password,
        },
      },
      impersonated,
    );

    assert.equal(changed.outcome, 'host-key-mismatch');
    assert.equal(changed.hostVerified, false);
    // The same previously accepted client pin was used, unchanged.
    assert.equal(changed.expectedFingerprint, CLIENT_EXPECTED_PINS.authorized);
    // Only the presented identity changed.
    assert.equal(changed.presentedFingerprint, ROTATED_PRESENTED_FINGERPRINT);
    assert.equal(changed.authAttempts, 0);
    assert.equal(changed.authentication.ok, false);
    assert.equal(changed.markerRead, false);
    assert.equal(changed.fallback.kind, 'manual-install');
  });

  test('password and private key fixtures both authenticate and read the marker', async () => {
    const password = await probeSsh({
      target: AUTHORIZED_TARGET,
      expectedFingerprint: CLIENT_EXPECTED_PINS.authorized,
      auth: {
        method: 'password',
        username: FIXTURE_CREDENTIALS.username,
        password: FIXTURE_CREDENTIALS.password,
      },
    });

    const privateKey = await probeSsh({
      target: AUTHORIZED_TARGET,
      expectedFingerprint: CLIENT_EXPECTED_PINS.authorized,
      auth: {
        method: 'private-key',
        username: FIXTURE_CREDENTIALS.username,
        privateKey: FIXTURE_CREDENTIALS.privateKey,
      },
    });

    assert.equal(password.outcome, 'authenticated');
    assert.equal(privateKey.outcome, 'authenticated');
    // Brief: expect(password.markerRead && privateKey.markerRead).toBe(true)
    assert.equal(password.markerRead && privateKey.markerRead, true);
    assert.equal(password.markerRead, true);
    assert.equal(privateKey.markerRead, true);
    assert.equal(password.authAttempts, 1);
    assert.equal(privateKey.authAttempts, 1);
  });

  test('encrypted private key fixture accepts its passphrase and rejects none', async () => {
    const encrypted = await probeSsh({
      target: AUTHORIZED_TARGET,
      expectedFingerprint: CLIENT_EXPECTED_PINS.authorized,
      auth: {
        method: 'private-key',
        username: FIXTURE_CREDENTIALS.username,
        privateKey: FIXTURE_CREDENTIALS.encryptedPrivateKey,
        passphrase: FIXTURE_CREDENTIALS.privateKeyPassphrase,
      },
    });

    const missingPassphrase = await probeSsh({
      target: AUTHORIZED_TARGET,
      expectedFingerprint: CLIENT_EXPECTED_PINS.authorized,
      auth: {
        method: 'private-key',
        username: FIXTURE_CREDENTIALS.username,
        privateKey: FIXTURE_CREDENTIALS.encryptedPrivateKey,
      },
    });

    assert.equal(encrypted.outcome, 'authenticated');
    assert.equal(encrypted.markerRead, true);
    assert.equal(missingPassphrase.outcome, 'authentication-failed');
    assert.equal(missingPassphrase.markerRead, false);
  });

  test('an unauthorized destination is refused before any dial', async () => {
    const unauthorizedTarget = await probeSsh({
      target: UNAUTHORIZED_TARGET,
      expectedFingerprint:
        'SHA256:pontaFixtureUnauthorizedEd25519Synthetic0000000000000000000',
      auth: {
        method: 'password',
        username: FIXTURE_CREDENTIALS.username,
        password: FIXTURE_CREDENTIALS.password,
      },
    });

    assert.equal(unauthorizedTarget.outcome, 'policy-refused');
    // Brief: expect(unauthorizedTarget.dialAttempts).toBe(0)
    assert.equal(unauthorizedTarget.dialAttempts, 0);
    assert.equal(unauthorizedTarget.authAttempts, 0);
  });

  test('an injected fixture transport observes no dial for an unauthorized target', async () => {
    const base = new FixtureWorker();
    let dialCalls = 0;
    const injected = {
      get dialAttempts() {
        return base.dialAttempts;
      },
      resolveApproved: (target: { host: string; port: number }) =>
        base.resolveApproved(target),
      dial: (target: { host: string; port: number }) => {
        dialCalls += 1;
        return base.dial(target);
      },
      audit: () => base.audit(),
    };

    const result = await probeSsh(
      {
        target: UNAUTHORIZED_TARGET,
        expectedFingerprint:
          'SHA256:pontaFixtureUnauthorizedEd25519Synthetic0000000000000000000',
        auth: {
          method: 'password',
          username: FIXTURE_CREDENTIALS.username,
          password: FIXTURE_CREDENTIALS.password,
        },
      },
      injected,
    );

    assert.equal(result.outcome, 'policy-refused');
    assert.equal(dialCalls, 0);
    assert.equal(result.dialAttempts, 0);
  });

  test('the fixture session refuses authentication before host verification', () => {
    const worker = new FixtureWorker();
    const dial = worker.dial({
      host: FIXTURE_ENDPOINTS.authorized.host,
      port: FIXTURE_ENDPOINTS.authorized.port,
    });
    assert.equal(dial.ok, true);
    if (!dial.ok) return;

    assert.throws(
      () =>
        dial.session.authenticatePassword(
          FIXTURE_CREDENTIALS.username,
          FIXTURE_CREDENTIALS.password,
        ),
      /host verification/i,
    );
    assert.equal(dial.session.authAttempts, 0);
  });

  test('an approved unreachable fixture reports an actionable manual install', async () => {
    const unreachable = await probeSsh({
      target: UNREACHABLE_TARGET,
      expectedFingerprint: CLIENT_EXPECTED_PINS.approvedUnreachable,
      auth: {
        method: 'password',
        username: FIXTURE_CREDENTIALS.username,
        password: FIXTURE_CREDENTIALS.password,
      },
    });

    assert.equal(unreachable.outcome, 'unreachable');
    assert.equal(unreachable.dialAttempts, 1);
    assert.equal(unreachable.authAttempts, 0);
    assert.equal(unreachable.fallback.kind, 'manual-install');
    assert.equal(unreachable.fallback.required, true);
    assert.match(unreachable.fallback.summary, /manual install/i);
    assert.ok(unreachable.fallback.steps.length > 0);
  });

  test('a target that is not a literal host:port is never dialed', async () => {
    const invalid = await probeSsh({
      target: 'fixture-hostname.example:22',
      expectedFingerprint: CLIENT_EXPECTED_PINS.authorized,
      auth: {
        method: 'password',
        username: FIXTURE_CREDENTIALS.username,
        password: FIXTURE_CREDENTIALS.password,
      },
    });

    assert.equal(invalid.outcome, 'invalid-target');
    assert.equal(invalid.dialAttempts, 0);
    assert.equal(invalid.fallback.kind, 'manual-install');
  });

  test('probe results, audit lines, and relay metadata never expose synthetic credentials', async () => {
    const results = await Promise.all([
      probeSsh({
        target: AUTHORIZED_TARGET,
        expectedFingerprint: CLIENT_EXPECTED_PINS.authorized,
        auth: {
          method: 'password',
          username: FIXTURE_CREDENTIALS.username,
          password: FIXTURE_CREDENTIALS.password,
        },
      }),
      probeSsh({
        target: AUTHORIZED_TARGET,
        expectedFingerprint: CLIENT_EXPECTED_PINS.authorized,
        auth: {
          method: 'private-key',
          username: FIXTURE_CREDENTIALS.username,
          privateKey: FIXTURE_CREDENTIALS.encryptedPrivateKey,
          passphrase: FIXTURE_CREDENTIALS.privateKeyPassphrase,
        },
      }),
    ]);

    for (const result of results) {
      assert.equal(result.markerRead, true);
      assert.equal(result.marker, FIXTURE_MARKER);
      assert.equal(result.scratchRoundTrip, true);
      assert.equal(result.audit.credentialLeakDetected, false);
      assert.equal(result.audit.payloadRetained, false);
      assert.ok(result.audit.relayBytes > 0);

      const serialized = JSON.stringify(result);
      const auditText = result.audit.lines.join('\n');
      for (const secret of ALL_FIXTURE_SECRETS) {
        assert.equal(serialized.includes(secret), false);
        assert.equal(auditText.includes(secret), false);
      }
    }
  });
});
