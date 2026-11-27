#!/usr/bin/env bash
set -euo pipefail
: "${PROBE_NODE_BIN:?Set the installed Node binary path}"
: "${PROBE_WS_PATH:?Set the installed ws package directory}"
: "${PROBE_WORKERD_BIN:?Set the installed workerd binary path}"
: "${PROBE_LIBATOMIC:?Set the compatible libatomic.so.1 path}"
: "${PROBE_CHROMIUM_DIR:?Set the installed Chromium headless shell directory}"
: "${PROBE_CHROMIUM_LIBS:?Set the directory with the compatible loader and libraries}"
: "${PROBE_GO_AGENT:?Set the compiled fixture Go agent path}"
for path in "$PROBE_NODE_BIN" "$PROBE_WS_PATH" "$PROBE_WORKERD_BIN" "$PROBE_LIBATOMIC" \
    "$PROBE_CHROMIUM_DIR" "$PROBE_CHROMIUM_LIBS" "$PROBE_GO_AGENT"; do
  [[ "$path" = /* && -r "$path" ]] || { printf 'Dependencies must be absolute readable paths.\n' >&2; exit 2; }
done
probe=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
runtime=${1:-both}
case "$runtime" in node|workerd|both) ;; *) exit 2 ;; esac
run() {
  docker run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 65534:65534 --memory=768m --pids-limit=128 \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --mount "type=bind,src=$probe,dst=/probe,readonly" \
    --mount "type=bind,src=$PROBE_NODE_BIN,dst=/opt/probe/node,readonly" \
    --mount "type=bind,src=$PROBE_WS_PATH,dst=/opt/probe/ws,readonly" \
    --mount "type=bind,src=$PROBE_WORKERD_BIN,dst=/opt/probe/workerd,readonly" \
    --mount "type=bind,src=$PROBE_LIBATOMIC,dst=/opt/probe/libatomic.so.1,readonly" \
    --mount "type=bind,src=$PROBE_CHROMIUM_DIR,dst=/opt/browser,readonly" \
    --mount "type=bind,src=$PROBE_CHROMIUM_LIBS,dst=/opt/browser-libs,readonly" \
    --mount "type=bind,src=$PROBE_GO_AGENT,dst=/opt/probe/agent,readonly" \
    --env LD_LIBRARY_PATH=/opt/probe --env PROBE_WS_MODULE=/opt/probe/ws --env "PROBE_RUNTIME=$1" \
    --entrypoint /opt/probe/node ubuntu:26.04 --test /probe/browser-go/interop.mjs
}
if [[ "$runtime" == both ]]; then
  run node
  run workerd
else
  run "$runtime"
fi
