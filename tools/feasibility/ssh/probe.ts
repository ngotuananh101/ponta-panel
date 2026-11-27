/**
 * Test-only SSH feasibility probe for Phase 1 Task 1.
 *
 * Scope: strictly local fixture contract. This module performs host
 * verification before authentication, exercises the password and private-key
 * fixture paths, refuses destinations outside the fixture allowlist without
 * dialing, and returns an actionable manual-install fallback for an approved
 * unreachable fixture.
 *
 * It does NOT open a network connection, run an installer, select a real SSH
 * library, or prove Cloudflare Worker outbound TCP. The transport is an
 * in-process/injected fixture (`worker.ts`). A separate authorization is
 * required for live Worker and browser SSH evidence.
 */

import {
  FIXTURE_SCRATCH_DIR,
  FixtureWorker,
  type FixtureAudit,
  type FixtureEndpoint,
  type FixtureTarget,
} from './worker.ts';

export type FixtureAuth =
  | {
      readonly method: 'password';
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly method: 'private-key';
      readonly username: string;
      readonly privateKey: string;
      readonly passphrase?: string;
    };

export type SshProbeInput = {
  readonly target: string;
  readonly expectedFingerprint: string;
  readonly auth: FixtureAuth;
};

/**
 * Narrow fixture transport seam so the probe logic can be unit-tested without
 * any I/O and later pointed at a differently constructed fixture. It is not a
 * generic TCP proxy and exposes no arbitrary destination.
 */
export type FixtureTransport = {
  readonly dialAttempts: number;
  resolveApproved(target: FixtureTarget): FixtureEndpoint | undefined;
  dial(target: FixtureTarget): ReturnType<FixtureWorker['dial']>;
  audit(): FixtureAudit;
};

export type SshProbeOutcome =
  | 'authenticated'
  | 'policy-refused'
  | 'host-key-mismatch'
  | 'authentication-failed'
  | 'unreachable'
  | 'invalid-target';

export type FallbackAdvice = {
  readonly required: boolean;
  readonly kind: 'none' | 'manual-install';
  readonly summary: string;
  readonly steps: readonly string[];
};

export type SshProbeResult = {
  /** True marks evidence as fixture-only; never real-host evidence. */
  readonly fixtureOnly: true;
  readonly target: string;
  readonly outcome: SshProbeOutcome;
  readonly hostVerified: boolean;
  /** Client-side pin supplied by the caller; not read from the server. */
  readonly expectedFingerprint: string;
  /**
   * Identity the simulated server presented, when a session was opened. This is
   * fixture simulation only and must never be treated as protocol evidence.
   */
  readonly presentedFingerprint?: string;
  readonly dialAttempts: number;
  readonly authAttempts: number;
  readonly authentication: {
    readonly ok: boolean;
    readonly method: FixtureAuth['method'] | 'none';
    readonly detail?: string;
  };
  readonly markerRead: boolean;
  readonly marker?: string;
  readonly scratchRoundTrip: boolean;
  readonly scratchPath?: string;
  readonly fallback: FallbackAdvice;
  readonly audit: FixtureAudit;
};

const NO_FALLBACK: FallbackAdvice = Object.freeze({
  required: false,
  kind: 'none',
  summary: 'No manual fallback is required for this fixture outcome.',
  steps: [],
});

const MANUAL_INSTALL_STEPS: readonly string[] = Object.freeze([
  'Confirm from the owner network that the destination address and SSH port are reachable.',
  'Verify the host key fingerprint through the provider console or an existing known-host record.',
  'Use the manual enrollment flow from an unlocked, trusted device and pair the agent.',
]);

function manualInstallFallback(reason: string): FallbackAdvice {
  return Object.freeze({
    required: true,
    kind: 'manual-install',
    summary: `Manual install is required: ${reason}`,
    steps: MANUAL_INSTALL_STEPS,
  });
}

/**
 * Parses `host:port` literally. IPv4 only in this fixture; no DNS resolution
 * and no bracketed IPv6 form, because an IPv6 parser would be untested
 * production behavior rather than feasibility scaffolding.
 */
export function parseFixtureTarget(raw: string): FixtureTarget | undefined {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(raw);
  if (!match) return undefined;

  const host = match[1];
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;

  const octets = host.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
  ) {
    return undefined;
  }

  return { host, port };
}

type ResultOverrides = Partial<
  Pick<
    SshProbeResult,
    | 'hostVerified'
    | 'presentedFingerprint'
    | 'dialAttempts'
    | 'authAttempts'
    | 'authentication'
    | 'fallback'
  >
>;

function baseResult(
  input: SshProbeInput,
  outcome: SshProbeOutcome,
  transport: FixtureTransport,
  overrides: ResultOverrides = {},
): SshProbeResult {
  return {
    fixtureOnly: true,
    target: input.target,
    outcome,
    hostVerified: false,
    expectedFingerprint: input.expectedFingerprint,
    dialAttempts: transport.dialAttempts,
    authAttempts: 0,
    authentication: { ok: false, method: 'none' },
    markerRead: false,
    scratchRoundTrip: false,
    fallback: NO_FALLBACK,
    audit: transport.audit(),
    ...overrides,
  };
}

/**
 * Runs one fixture SSH contract check.
 *
 * @param input target as `host:port`, the client-side expected fingerprint pin,
 *   and a synthetic password-or-private-key fixture credential. The pin is
 *   supplied by the caller and is never derived from the simulated server's
 *   presented identity.
 * @param transport fixture-only seam; defaults to a fresh in-process fixture.
 */
export async function probeSsh(
  input: SshProbeInput,
  transport: FixtureTransport = new FixtureWorker(),
): Promise<SshProbeResult> {
  const parsed = parseFixtureTarget(input.target);
  if (!parsed) {
    return baseResult(input, 'invalid-target', transport, {
      fallback: manualInstallFallback(
        'the target is not a literal IPv4 host:port and was not dialed',
      ),
    });
  }

  // Policy is evaluated before dialing, so a refused destination can never
  // produce a connection attempt.
  if (transport.resolveApproved(parsed) === undefined) {
    return baseResult(input, 'policy-refused', transport, {
      authentication: {
        ok: false,
        method: input.auth.method,
        detail:
          'destination refused by fixture endpoint allowlist before dial',
      },
      fallback: manualInstallFallback(
        'the destination is not eligible for automatic SSH bootstrap',
      ),
    });
  }

  const dial = transport.dial(parsed);
  if (!dial.ok) {
    return baseResult(
      input,
      dial.reasonCode === 'endpoint_unreachable'
        ? 'unreachable'
        : 'policy-refused',
      transport,
      {
        authentication: {
          ok: false,
          method: input.auth.method,
          detail: dial.message,
        },
        fallback: manualInstallFallback(dial.message),
      },
    );
  }

  const session = dial.session;

  // Host verification must complete before any credential is offered. The
  // presented identity comes from the fixture server side; the expected pin
  // comes from the caller and is compared literally.
  const hostVerified = session.verifyHost(input.expectedFingerprint);
  if (!hostVerified) {
    return baseResult(input, 'host-key-mismatch', transport, {
      hostVerified: false,
      presentedFingerprint: session.presentedFingerprint,
      authAttempts: session.authAttempts,
      authentication: {
        ok: false,
        method: input.auth.method,
        detail:
          'presented host key did not match the pinned fingerprint; authentication was not attempted',
      },
      fallback: manualInstallFallback(
        'the host key did not match the pinned fingerprint, so the automatic flow stopped',
      ),
    });
  }

  let authOk = false;
  let detail: string;
  if (input.auth.method === 'password') {
    authOk = session.authenticatePassword(
      input.auth.username,
      input.auth.password,
    );
    detail = authOk
      ? 'fixture password authentication accepted'
      : 'fixture password authentication rejected';
  } else {
    const keyResult = session.authenticatePrivateKey(
      input.auth.username,
      input.auth.privateKey,
      input.auth.passphrase,
    );
    authOk = keyResult.ok;
    detail = keyResult.ok
      ? 'fixture private-key authentication accepted'
      : `fixture private-key authentication rejected (${keyResult.reason})`;
  }

  if (!authOk) {
    return baseResult(input, 'authentication-failed', transport, {
      hostVerified: true,
      presentedFingerprint: session.presentedFingerprint,
      authAttempts: session.authAttempts,
      authentication: { ok: false, method: input.auth.method, detail },
    });
  }

  const marker = session.readMarker();

  const scratchName = 'fixture-marker.txt';
  const scratchContents = `${marker}\n`;
  session.writeScratch(scratchName, scratchContents);
  const scratchRoundTrip = session.readScratch(scratchName) === scratchContents;

  return {
    fixtureOnly: true,
    target: input.target,
    outcome: 'authenticated',
    hostVerified: true,
    expectedFingerprint: input.expectedFingerprint,
    presentedFingerprint: session.presentedFingerprint,
    dialAttempts: transport.dialAttempts,
    authAttempts: session.authAttempts,
    authentication: { ok: true, method: input.auth.method, detail },
    markerRead: session.markerRead,
    marker,
    scratchRoundTrip,
    scratchPath: `${FIXTURE_SCRATCH_DIR}/${scratchName}`,
    fallback: NO_FALLBACK,
    audit: transport.audit(),
  };
}
