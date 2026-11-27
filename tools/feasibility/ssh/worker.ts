/**
 * Fixture-only Worker transport for the Phase 1 SSH feasibility probe.
 *
 * This is an in-process stand-in for a Worker outbound-TCP adapter. It performs
 * no I/O, opens no listener, forwards no public traffic, and can reach only the
 * fixed synthetic endpoints below. It is feasibility scaffolding, not
 * production code, and it does not prove that Cloudflare Workers can open an
 * outbound SSH connection.
 *
 * No real VPS, credential, host key, or relay is represented here. Every value
 * is synthetic and fixed so the local contract is reproducible.
 */

export const FIXTURE_MARKER = 'PONTA_FIXTURE_MARKER_V1';
export const FIXTURE_SCRATCH_DIR = '/fixture-disposable-scratch';

/**
 * Synthetic, non-functional fixture credentials. They only match string
 * equality inside this fixture and must never be used against a real host.
 */
export const FIXTURE_CREDENTIALS = Object.freeze({
  username: 'ponta-fixture-owner',
  password: 'fixture-password-7c1d-synthetic',
  privateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nPONTA-FIXTURE-SYNTHETIC-KEY-MATERIAL-NOT-A-REAL-KEY\n-----END OPENSSH PRIVATE KEY-----',
  encryptedPrivateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nPONTA-FIXTURE-SYNTHETIC-ENCRYPTED-KEY-MATERIAL-NOT-A-REAL-KEY\n-----END OPENSSH PRIVATE KEY-----',
  privateKeyPassphrase: 'fixture-passphrase-4a9e-synthetic',
});

export type FixtureEndpoint = {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  /**
   * The identity this simulated server would present to a client. This is the
   * server side of the fixture only. It is NOT the trusted pin a client should
   * compare against; the client-side expected pin is declared independently in
   * the test fixture so the two sources cannot silently agree by construction.
   */
  readonly presentedFingerprint: string;
  readonly approved: boolean;
  readonly reachable: boolean;
  readonly unreachableReason?: string;
};

/**
 * The only destinations the fixture transport will consider dialing.
 *
 * TEST-NET-1 and TEST-NET-3 documentation ranges keep the values obviously
 * synthetic. They are fixed and parsed literally; no DNS resolution happens.
 */
export const FIXTURE_ENDPOINTS: Readonly<Record<string, FixtureEndpoint>> =
  Object.freeze({
    authorized: Object.freeze({
      id: 'authorized',
      host: '192.0.2.10',
      port: 22,
      presentedFingerprint:
        'SHA256:pontaFixtureAuthorizedEd25519Synthetic000000000000000000',
      approved: true,
      reachable: true,
    }),
    approvedUnreachable: Object.freeze({
      id: 'approved-unreachable',
      host: '203.0.113.7',
      port: 22,
      presentedFingerprint:
        'SHA256:pontaFixtureUnreachableEd25519Synthetic0000000000000000000',
      approved: true,
      reachable: false,
      unreachableReason:
        'outbound TCP to this approved fixture destination is blocked by fixture policy',
    }),
  });

/**
 * Fixture-worker construction options.
 *
 * `presentedFingerprints` lets a test change only the identity the simulated
 * server presents (for example, simulate a rotated or impersonated host key)
 * while the client keeps the previously accepted pin. Endpoints not listed keep
 * their `presentedFingerprint`. This is simulation scaffolding; it says nothing
 * about real host-key handling.
 */
export type FixtureWorkerOptions = {
  readonly presentedFingerprints?: Readonly<Record<string, string>>;
};

export type FixtureTarget = { readonly host: string; readonly port: number };

export type FixtureDialResult =
  | { readonly ok: true; readonly session: FixtureSshSession }
  | {
      readonly ok: false;
      readonly reasonCode: 'policy_refused' | 'endpoint_unreachable';
      readonly message: string;
    };

export type FixturePrivateKeyAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'bad_passphrase' | 'rejected' };

export type FixtureAudit = {
  readonly lines: readonly string[];
  readonly credentialLeakDetected: boolean;
  readonly relayBytes: number;
  readonly payloadRetained: false;
};

const SECRET_VALUES: readonly string[] = [
  FIXTURE_CREDENTIALS.username,
  FIXTURE_CREDENTIALS.password,
  FIXTURE_CREDENTIALS.privateKey,
  FIXTURE_CREDENTIALS.encryptedPrivateKey,
  FIXTURE_CREDENTIALS.privateKeyPassphrase,
];

function containsSecret(value: string): boolean {
  return SECRET_VALUES.some((secret) => value.includes(secret));
}

export function findFixtureEndpoint(
  target: FixtureTarget,
): FixtureEndpoint | undefined {
  return Object.values(FIXTURE_ENDPOINTS).find(
    (endpoint) =>
      endpoint.host === target.host && endpoint.port === target.port,
  );
}

/**
 * Fixture-only byte stream. It records byte counts and never retains payload
 * bytes, so a caller cannot accidentally exfiltrate credentials through it.
 */
export class FixtureByteForwarder {
  #relayBytes = 0;

  forwardToHost(bytes: Uint8Array): void {
    this.#relayBytes += bytes.byteLength;
  }

  forwardToBrowser(bytes: Uint8Array): void {
    this.#relayBytes += bytes.byteLength;
  }

  get relayBytes(): number {
    return this.#relayBytes;
  }
}

export class FixtureSshSession {
  readonly endpoint: FixtureEndpoint;
  readonly presentedFingerprint: string;

  #hostVerified = false;
  #authAttempts = 0;
  #authenticated = false;
  #markerRead = false;
  #scratch = new Map<string, string>();
  readonly #audit: (line: string) => void;
  readonly #forwarder: FixtureByteForwarder;

  constructor(
    endpoint: FixtureEndpoint,
    presentedFingerprint: string,
    audit: (line: string) => void,
    forwarder: FixtureByteForwarder,
  ) {
    this.endpoint = endpoint;
    this.presentedFingerprint = presentedFingerprint;
    this.#audit = audit;
    this.#forwarder = forwarder;
  }

  /** Called once before any authentication. */
  verifyHost(expectedFingerprint: string): boolean {
    this.#hostVerified =
      expectedFingerprint.length > 0 &&
      expectedFingerprint === this.presentedFingerprint;
    this.#audit(
      `host-verification fingerprint-presented=${this.presentedFingerprint} matched=${this.#hostVerified}`,
    );
    return this.#hostVerified;
  }

  #requireVerifiedHost(): void {
    if (!this.#hostVerified) {
      throw new Error(
        'fixture SSH session refuses authentication before host verification',
      );
    }
  }

  authenticatePassword(username: string, password: string): boolean {
    this.#requireVerifiedHost();
    this.#authAttempts += 1;
    const ok =
      username === FIXTURE_CREDENTIALS.username &&
      password === FIXTURE_CREDENTIALS.password;
    this.#audit(
      `auth-method=password result=${ok ? 'accepted' : 'rejected'}`,
    );
    this.#authenticated = ok;
    return ok;
  }

  authenticatePrivateKey(
    username: string,
    privateKey: string,
    passphrase?: string,
  ): FixturePrivateKeyAuthResult {
    this.#requireVerifiedHost();
    this.#authAttempts += 1;

    if (username !== FIXTURE_CREDENTIALS.username) {
      this.#audit('auth-method=private-key username mismatch result=rejected');
      return { ok: false, reason: 'rejected' };
    }

    if (privateKey === FIXTURE_CREDENTIALS.privateKey) {
      if (passphrase !== undefined) {
        this.#audit(
          'auth-method=private-key key=plaintext result=rejected unexpected-passphrase',
        );
        return { ok: false, reason: 'rejected' };
      }
      this.#authenticated = true;
      this.#audit('auth-method=private-key key=plaintext result=accepted');
      return { ok: true };
    }

    if (privateKey === FIXTURE_CREDENTIALS.encryptedPrivateKey) {
      if (passphrase !== FIXTURE_CREDENTIALS.privateKeyPassphrase) {
        this.#audit(
          'auth-method=private-key key=encrypted result=rejected bad-passphrase',
        );
        return { ok: false, reason: 'bad_passphrase' };
      }
      this.#authenticated = true;
      this.#audit('auth-method=private-key key=encrypted result=accepted');
      return { ok: true };
    }

    this.#audit('auth-method=private-key result=rejected');
    return { ok: false, reason: 'rejected' };
  }

  get authAttempts(): number {
    return this.#authAttempts;
  }

  get authenticated(): boolean {
    return this.#authenticated;
  }

  get markerRead(): boolean {
    return this.#markerRead;
  }

  /** Reads the harmless fixture-only marker over the fixture SSH session. */
  readMarker(): string {
    if (!this.#authenticated) {
      throw new Error('fixture SSH session is not authenticated');
    }
    this.#markerRead = true;
    this.#forwarder.forwardToBrowser(new TextEncoder().encode(FIXTURE_MARKER));
    this.#audit('session read fixture marker');
    return FIXTURE_MARKER;
  }

  /** Writes to the fixture's in-memory disposable scratch space. */
  writeScratch(name: string, contents: string): void {
    if (!this.#authenticated) {
      throw new Error('fixture SSH session is not authenticated');
    }
    if (containsSecret(contents)) {
      throw new Error('fixture refuses to write credential material');
    }
    this.#scratch.set(name, contents);
    this.#forwarder.forwardToHost(new TextEncoder().encode(contents));
    this.#audit(`scratch write name=${name} bytes=${contents.length}`);
  }

  readScratch(name: string): string | undefined {
    return this.#scratch.get(name);
  }

  get relayBytes(): number {
    return this.#forwarder.relayBytes;
  }
}

/**
 * Fixture Worker adapter. A single instance corresponds to one probe run and
 * records dial attempts, a sanitized audit trail, and byte counts only.
 */
export class FixtureWorker {
  #dialAttempts = 0;
  #dialRefused = 0;
  #credentialLeakDetected = false;
  readonly #auditLines: string[] = [];
  readonly #forwarder = new FixtureByteForwarder();
  readonly #presentedFingerprints: Readonly<Record<string, string>>;

  constructor(options: FixtureWorkerOptions = {}) {
    this.#presentedFingerprints = options.presentedFingerprints ?? {};
  }

  /** The identity this simulated server presents for an endpoint id. */
  presentedFingerprintFor(endpoint: FixtureEndpoint): string {
    return this.#presentedFingerprints[endpoint.id] ?? endpoint.presentedFingerprint;
  }

  get dialAttempts(): number {
    return this.#dialAttempts;
  }

  get dialRefused(): number {
    return this.#dialRefused;
  }

  #record(line: string): void {
    if (containsSecret(line)) {
      this.#credentialLeakDetected = true;
      this.#auditLines.push('[fixture audit line redacted: credential material]');
      return;
    }
    this.#auditLines.push(line);
  }

  resolveApproved(target: FixtureTarget): FixtureEndpoint | undefined {
    const endpoint = findFixtureEndpoint(target);
    return endpoint?.approved ? endpoint : undefined;
  }

  /**
   * Opens the fixture transport to an approved fixed destination. Policy
   * refusal is decided before this method, so a non-approved destination can
   * never increment the dial count.
   */
  dial(target: FixtureTarget): FixtureDialResult {
    const endpoint = this.resolveApproved(target);
    if (!endpoint) {
      this.#dialRefused += 1;
      this.#record('dial refused: destination is not a fixture-approved endpoint');
      return {
        ok: false,
        reasonCode: 'policy_refused',
        message:
          'destination is not in the fixture-approved endpoint allowlist; no dial was attempted',
      };
    }

    this.#dialAttempts += 1;
    this.#record(
      `dial approved endpoint=${endpoint.id} host=${endpoint.host} port=${endpoint.port}`,
    );

    if (!endpoint.reachable) {
      this.#record(`dial failed endpoint=${endpoint.id} reason=unreachable`);
      return {
        ok: false,
        reasonCode: 'endpoint_unreachable',
        message: endpoint.unreachableReason ?? 'approved fixture is unreachable',
      };
    }

    return {
      ok: true,
      session: new FixtureSshSession(
        endpoint,
        this.presentedFingerprintFor(endpoint),
        (line) => this.#record(line),
        this.#forwarder,
      ),
    };
  }

  audit(): FixtureAudit {
    return {
      lines: [...this.#auditLines],
      credentialLeakDetected: this.#credentialLeakDetected,
      relayBytes: this.#forwarder.relayBytes,
      payloadRetained: false,
    };
  }
}
