# Chromium and Go WebSocket interop probe

Runs the same disposable relay on Node or local workerd, using Chromium's native WebSocket API and a small compiled Go endpoint. Chromium cannot open with an unknown grant. It then sends `[0, 127, 128, 255]`, Go checks the binary opcode and data and replies with `[254, 0, 19]`, and Chromium checks the binary reply. Chromium closes the socket and cannot open another using its old grant; Go must observe EOF rather than a read timeout. The browser API does not reveal HTTP rejection status, so the separate synthetic-client contract covers that assertion.

## Run offline

1. Use the [local relay runner prerequisites](../README.md#run-the-isolated-contract) and export its four dependency paths. Use a locally available `ubuntu:26.04` image. Neither runner pulls an image or publishes a host port.
2. Compile the fixture agent from the repository root using an already installed Go toolchain and cached `golang.org/x/net` v0.59.0 (both module checksums are pinned). Use an absolute output path in scratch space outside the mounted source directory. A missing module is a prerequisite, not permission for an implicit network fetch.

   ```sh
   export PROBE_GO_AGENT=/absolute/scratch/path/agent
   GOTOOLCHAIN=local GOWORK=off GOPROXY=off CGO_ENABLED=0 \
     go -C tools/feasibility/realtime/self-hosted/browser-go \
     build -mod=readonly -trimpath -o "$PROBE_GO_AGENT" .
   ```

3. Set `PROBE_CHROMIUM_DIR` to a trusted installed Linux Chromium headless-shell directory (including the executable and its adjacent ICU/resource files). Set `PROBE_CHROMIUM_LIBS` to a directory with any additional compatible shared libraries missing from the image. Do not replace the image's dynamic loader or glibc: launching the browser via another loader may prevent it finding its adjacent resource files. These are read-only mounts; no browser profile or system service is reused.

   ```sh
   export PROBE_CHROMIUM_DIR=/absolute/path/to/chrome-headless-shell-linux64
   export PROBE_CHROMIUM_LIBS=/absolute/path/to/compatible-shared-libraries
   bash tools/feasibility/realtime/self-hosted/browser-go/run-interop.sh both
   ```

`node` or `workerd` runs only that relay. The harness uses a disposable Chromium profile on container tmpfs. Chromium's internal sandbox is disabled for this **synthetic local fixture only**. Keep the container network-isolated (`--network none`), unprivileged, and read-only apart from scratch. Run only the supplied test page; never use this configuration for live browsing, real credentials, or untrusted inputs.

## Evidence boundary

The test page and WebSocket relay listen on separate ports inside the container's loopback namespace. For this run, the disposable relay explicitly allows the page's `http://127.0.0.1:8784` Origin. The Go probe uses that fixed origin because its socket library requires an Origin. Without the override the relay retains the fixed test Origin used by the synthetic-client contract. The routing grants are synthetic and ephemeral, not endpoint identity. Nothing uses SSH, a PTY, a real Go agent service, TLS/E2EE, a deployed Worker, or a managed provider. No production client library or browser support matrix is selected by this experiment.
