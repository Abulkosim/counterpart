# Shared by the smoke scripts. Source it after `cd` to the repo root.
# On any failure the logs of the relay and both daemons are printed and the
# work directory is kept, so a failure that cannot be repeated can still be read.
# These scripts start their own daemons.
export CPART_NO_AUTOSTART=1
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cpart-smoke.XXXXXX")
# CPART_BIN=/path/to/cpart runs the smoke against an installed cpart, such as
# one from npm, instead of this checkout. The scripts run the checkout as
# `node [<repo>/]packages/cli/src/main.ts`, also inside `sh -c`, so a `node`
# first on PATH sends that to $CPART_BIN and everything else to the real node.
if [ -n "${CPART_BIN:-}" ]; then
  mkdir "$WORK/shim"
  printf '#!/bin/sh\ncase "$1" in *packages/cli/src/main.ts) shift; exec %s "$@" ;; esac\nexec %s "$@"\n' \
    "'$(command -v "$CPART_BIN")'" "'$(command -v node)'" >"$WORK/shim/node"
  chmod +x "$WORK/shim/node"
  export PATH="$WORK/shim:$PATH"
fi
# A fixed port can still be held by another run. Take a free one unless told otherwise.
PORT=${PORT:-$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}
RELAY=ws://127.0.0.1:$PORT
RELAY_PID=
pids=()
cleanup() {
  local code=$?
  trap - EXIT
  kill "${pids[@]}" 2>/dev/null || true
  wait 2>/dev/null || true
  if [ "$code" -ne 0 ]; then
    {
      printf '\nFAILED with exit code %s on port %s. Logs follow.\n' "$code" "$PORT"
      for f in "$WORK"/*.log "$WORK"/wait.out; do
        [ -e "$f" ] || continue
        printf -- '---- %s\n' "$f"
        cat -v "$f"
      done
      printf -- '---- work directory kept: %s\n' "$WORK"
    } >&2
  else
    rm -rf "$WORK"
  fi
  exit "$code"
}
trap cleanup EXIT
# Say which command ended the run. `set -e` alone exits without a word.
set -E
trap 'echo "FAIL: line $LINENO: $BASH_COMMAND" >&2' ERR
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
count() { grep -c -- "$1" "$2" 2>/dev/null || true; }
# wait_for <description> <command...>. The last attempt's output is kept for the failure report.
wait_for() {
  local what=$1; shift
  for _ in $(seq 1 100); do if "$@" >"$WORK/wait.out" 2>&1; then return 0; fi; sleep 0.1; done
  fail "timed out waiting for $what"
}
# Waits for this relay process to say it is listening. A health check alone
# would also pass against somebody else's relay on the same port.
start_relay() {
  local before
  before=$(count "relay listening" "$WORK/relay.log")
  node packages/cli/src/main.ts relay --port "$PORT" --db "$WORK/relay.db" >>"$WORK/relay.log" 2>&1 &
  RELAY_PID=$!
  pids+=("$RELAY_PID")
  for _ in $(seq 1 300); do
    if [ "$(count "relay listening" "$WORK/relay.log")" -gt "${before:-0}" ] && curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then return 0; fi
    kill -0 "$RELAY_PID" 2>/dev/null || fail "the relay exited while starting on port $PORT"
    sleep 0.1
  done
  fail "timed out waiting for the relay on port $PORT"
}
# start_daemon <who> [VAR=value...]: starts a daemon and waits until it has logged in.
start_daemon() {
  local who=$1 pid before; shift
  before=$(count "^connected" "$WORK/$who.log")
  env CPART_HOME="$WORK/$who" "$@" node packages/cli/src/main.ts daemon >>"$WORK/$who.log" 2>&1 &
  pid=$!
  pids+=("$pid")
  eval "${who}_PID=$pid"
  for _ in $(seq 1 300); do
    if [ "$(count "^connected" "$WORK/$who.log")" -gt "${before:-0}" ]; then return 0; fi
    kill -0 "$pid" 2>/dev/null || fail "the $who daemon exited while starting"
    sleep 0.1
  done
  fail "timed out waiting for the $who daemon"
}
