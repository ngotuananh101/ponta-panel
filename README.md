# ponta-panel

This repository currently contains feasibility probes, not a deployable VPS panel. The probes use disposable fixtures or an explicitly authorized test endpoint.

## Verify locally

With Node.js 26, run the tracked offline suite from the repository root:

```sh
node --test tools/feasibility/ssh/ssh.probe.test.ts \
  tools/feasibility/ssh/banner-reader.test.mjs \
  tools/feasibility/ssh/banner-worker.test.mjs \
  tools/feasibility/realtime/fixture.test.mjs
```

- [Realtime framing fixture](tools/feasibility/realtime/README.md): five provider options share one offline simulation; there are no production adapters.
- [Isolated relay contract](tools/feasibility/realtime/self-hosted/README.md) and [Chromium–Go interop](tools/feasibility/realtime/self-hosted/browser-go/README.md): Node and local workerd WebSockets in disposable Docker containers without host ports.
- [SSH feasibility](tools/feasibility/ssh/README.md): synthetic bootstrap policy and the limits of the SSH banner check.

## Live checks and limits

A separately authorized Laravel Reverb test app passed a WSS handshake, a private-channel Chromium–Go client-event exchange, a signed HTTPS publish with verified delivery, and rejection of subscriptions using a signature bound to a different socket or channel. Those checks do not verify the intended panel Origin, revocation on an already subscribed socket, throughput, or deployment parity. Live probe credentials and local scratch are intentionally excluded.

The repository is still at the feasibility stage. Browser SSH, mutual E2EE, push, resumable file transfers, and the deployment/provider matrix are not production-verified.