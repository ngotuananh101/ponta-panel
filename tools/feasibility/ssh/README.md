# SSH feasibility probe (Task 1, strictly local portion)

Throwaway feasibility scaffolding for Phase 1 Task 1: browser SSH through
Workers. This directory exists only to record the local fixture contract and the
gates still blocked on separate live authorization. It is **not production
code** and must not be carried into the production workspace.

## What is proven locally

`ssh.probe.test.ts` runs `probeSsh` against the in-process fixture transport in
`worker.ts` and asserts:

- A wrong host fingerprint yields `authAttempts === 0`: host verification
  happens before any credential is offered.
- The client-side expected pin is declared separately from the identity the
  simulated server presents. The success cases compare those two independent
  values, and a regression changes only the presented identity: the same
  previously accepted pin then fails closed with `authAttempts === 0`.
- The password fixture and the private-key fixture both authenticate and read
  the harmless fixture marker.
- An encrypted private-key fixture authenticates with its passphrase and is
  rejected when the passphrase is absent.
- A destination outside the fixture allowlist yields `dialAttempts === 0`
  because policy is evaluated before dialing. An injected transport confirms no
  `dial` call happens either.
- The fixture SSH session throws if authentication is attempted before host
  verification.
- An approved but unreachable fixture returns an actionable `manual-install`
  fallback with steps.
- A target that is not a literal `host:port` is never dialed.
- Serialized probe results, audit lines, and relay byte metadata never contain
  the synthetic credentials; the forwarder retains counts, not payload bytes.

## Fixtures (synthetic only)

All values are fixed and synthetic. Nothing here resolves DNS, opens a socket,
or contacts a real host.

The expected pin and the presented identity are intentionally separate sources:
`CLIENT_EXPECTED_PINS` in the test is the client-side pin, and
`FIXTURE_ENDPOINTS[*].presentedFingerprint` in `worker.ts` is what the simulated
server presents. They agree by value today; they are not derived from each
other.

| Endpoint id | Host:port | Presented identity (simulated server) | State |
| --- | --- | --- | --- |
| `authorized` | `192.0.2.10:22` (TEST-NET-1) | `SHA256:pontaFixtureAuthorizedEd25519Synthetic000000000000000000` | reachable |
| `approved-unreachable` | `203.0.113.7:22` (TEST-NET-3) | `SHA256:pontaFixtureUnreachableEd25519Synthetic0000000000000000000` | policy-approved, unreachable |

Credentials are synthetic strings that only match string equality inside
`worker.ts`. They are not keys, not passwords for any host, and must never be
used against a real system.

### Fixture injection seam

`probeSsh(input, transport?)` accepts an injected fixture transport with the
narrow `FixtureTransport` shape (`dialAttempts`, `resolveApproved`, `dial`,
`audit`). `new FixtureWorker({ presentedFingerprints })` can change only the
identity the simulated server presents. The seam is for local simulation and
testability; it is not a generic TCP proxy and exposes no arbitrary destination.
Do not treat injected transports as protocol or Worker evidence.

Teardown: none. The fixture has no listeners, containers, ports, files outside
the process, or persisted state.

## Runner deviation

The brief's command is
`pnpm exec vitest run tools/feasibility/ssh/ssh.probe.test.ts`. The controller
for this task restricted work to strictly local tooling with no dependency
fetching, so the built-in Node test runner is used instead:

```sh
node --test tools/feasibility/ssh/ssh.probe.test.ts
```

This is a deviation from the brief under controller direction, not something
the original brief authorized. Vitest is not installed in this worktree, and
installing it requires fetching dependencies or letting pnpm 12 auto-install on
`exec`, both outside those boundaries. The brief's `expect(...)` assertions map
one-to-one to `node:assert/strict` (see the header of the test file). Vitest
remains a candidate for the live probe only after dependency installation is
explicitly authorized.

## Blocked / not proven here

These require separate, explicit live authorization and are **not** evidence
from this local run:

- A real Cloudflare Worker opening an outbound TCP connection with
  `cloudflare:sockets` (or the equivalent) directly, without an additional
  Docker relay.
- A browser-compatible SSH client that supports a WebSocket byte transport,
  verifies the host key before authentication, and negotiates password,
  plaintext private key, and encrypted private key.
- SSH session and file transfer of the fixture marker to a disposable scratch
  space on an authorized SSH fixture.
- Absence of credential exposure in real Worker logs and relay traffic.
- Minimum supported key types and privilege prerequisites for the production
  plan.

No live resources were created or torn down; there is nothing to tear down.

## Library evaluation (unresolved)

No SSH library was selected. The spec leaves the browser SSH client open and
lists WebAssembly as a candidate, not a commitment. Choosing a maintained
browser-compatible implementation requires the live Worker/browser run above,
so this task records the requirement and defers the choice. Do not treat this
fixture as evidence that any candidate passes.
