# Self-hosted WebSocket probe

Disposable feasibility check for a Node WebSocket server and a local workerd Durable Object. Both run the same relay policy and real wire-level contract with synthetic `ws` clients. It is separate from the parent directory's in-memory framing and broker fault simulator. Do not deploy or import this probe in the product.

## Run the isolated contract

Use a local Docker engine with `ubuntu:26.04` already present, a Linux Node.js binary compatible with the image/architecture, its compatible `libatomic.so.1`, an installed `ws` package directory, and an installed workerd binary. No package installation, image pull, Wrangler authentication, or Workers deployment occurs in the script. Set all four paths to trusted installed files before running it from the repository root:

```sh
export PROBE_NODE_BIN=/absolute/path/to/node
export PROBE_WS_PATH=/absolute/path/to/node_modules/ws
export PROBE_WORKERD_BIN=/absolute/path/to/workerd
export PROBE_LIBATOMIC=/absolute/path/to/libatomic.so.1
bash tools/feasibility/realtime/self-hosted/run-local.sh both
```

Use `node` or `workerd` instead of `both` to select one runtime. A Node test option can follow, for example `workerd --test-name-pattern='forwards distinct'`. Tested with Node v26.13.1, `ws` 8.21.0 (MIT) and workerd 1.20261123.1 (Apache-2.0, reports `2026-11-23`). Each runtime runs in a disposable read-only container with `--network none`, no published ports, no privileges and read-only mounts for the probe and existing tooling. Both server and test clients use the container's loopback interface. Workerd's local config also denies outbound peers. The suite generates distinct one-use synthetic grants for each server process; no credentials or service addresses are needed.

## Contract and evidence boundary

- One fixed `/probe` route per server boot. The requested WebSocket protocols carry the fixed public protocol plus a role's opaque fixture grant. Only the public protocol is selected. The browser fixture requires the exact test Origin; the agent fixture can omit it. Grants are not included in URLs or reported by the probe. A WebSocket terminator can see the offer. Never put SSH credentials, private keys, or other management secrets in these headers. This carrier is not a production authentication decision.
- At most one socket per role. After both attach, forward only binary data to the opposite role. Retire both sides on a close, a socket error, data without a receiver, a nonbinary or oversize message, or a send beyond the combined budget. The route expires after a fixed lifetime from the first attachment, not after inactivity. It never buffers a replay or reopens with the retired grants. The local config sets `preventEviction` to keep the fixture from losing its in-memory state to eviction during the run; eviction or restart is not exercised. No hibernation or production persistence claim.
- Probe caps: 512 bytes per message and 128 messages total in both directions (at most 64 KiB of accepted payload over the session). This is not a measurement of queue depth, network backpressure, or Workers ingress memory. Node rejects the oversize test message in `ws` before the shared policy sees it; `ws` compression is disabled. Local workerd delivers the whole message, then the shared policy checks its size. The local workerd build delivered `Blob` by default; the probe explicitly requests `ArrayBuffer`. That default was not checked against deployed Cloudflare Workers. The isolated transport uses plain `ws://` because it has no external listeners or real data; this is not permission for a plaintext production fallback.
- This synthetic-client contract does not prove Go/browser interop, Cloudflare edge behavior, hibernation, TLS or E2EE, multi-agent throughput, rate/latency limits, or any managed provider behavior. There is no PTY, arbitrary destination, SSH/bulk transport, external notification, or real VPS access. The separate [Chromium and Go interop probe](browser-go/README.md) checks only local browser/Go interoperability for the same relay.
