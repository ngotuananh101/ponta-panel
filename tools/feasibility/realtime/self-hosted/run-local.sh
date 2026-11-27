#!/usr/bin/env bash
# Use only installed binaries, an existing local image, and a fresh network namespace.
set -euo pipefail
: "${PROBE_NODE_BIN:?Set an absolute path to an installed Node.js binary}"
: "${PROBE_WS_PATH:?Set an absolute path to an installed ws package directory}"
: "${PROBE_WORKERD_BIN:?Set an absolute path to an installed workerd binary}"
: "${PROBE_LIBATOMIC:?Set an absolute path to a compatible libatomic.so.1}"
runtime=${1:-both}
case "$runtime" in node|workerd|both) ;; *) exit 2 ;; esac
shift $(( $# > 0 ? 1 : 0 ))
for dependency in "$PROBE_NODE_BIN" "$PROBE_WS_PATH" "$PROBE_WORKERD_BIN" "$PROBE_LIBATOMIC"; do
  [[ "$dependency" = /* && -r "$dependency" ]] || { printf 'Each dependency must be an absolute readable path.\n' >&2; exit 2; }
done
probe=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
run() {
  local target=$1
  shift
  docker run --rm --pull=never --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 65534:65534 --memory=512m --pids-limit=64 \
    --mount "type=bind,src=$probe,dst=/probe,readonly" \
    --mount "type=bind,src=$PROBE_NODE_BIN,dst=/opt/probe/node,readonly" \
    --mount "type=bind,src=$PROBE_WS_PATH,dst=/opt/probe/ws,readonly" \
    --mount "type=bind,src=$PROBE_WORKERD_BIN,dst=/opt/probe/workerd,readonly" \
    --mount "type=bind,src=$PROBE_LIBATOMIC,dst=/opt/probe/libatomic.so.1,readonly" \
    --env LD_LIBRARY_PATH=/opt/probe --env "PROBE_RUNTIME=$target" \
    --env PROBE_WS_MODULE=/opt/probe/ws --env PROBE_WORKERD=/opt/probe/workerd \
    --entrypoint /opt/probe/node ubuntu:26.04 --test "$@" /probe/socket.contract.mjs
}
if [[ "$runtime" == both ]]; then
  run node "$@"
  run workerd "$@"
else
  run "$runtime" "$@"
fi
