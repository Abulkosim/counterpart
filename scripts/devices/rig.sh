#!/usr/bin/env bash
# Two devices that talk through Counterpart: "laptop" and "devcontainer", each
# a Docker container with its own disk, network namespace, CPART_HOME,
# Counterpart checkout (installed with install.sh), Claude Code and repo.
# Runs the scenarios in scripts/devices/scenarios and writes results.json and
# report.md. See scripts/devices/README.md.
#
#   ./scripts/devices/rig.sh                      every scenario, relay on this machine (or in a container if the firewall blocks that)
#   ./scripts/devices/rig.sh --mode tunnel        relay behind cpart relay --tunnel. Needs cloudflared
#   ./scripts/devices/rig.sh --no-sessions        only the scenarios that use no model
#   ./scripts/devices/rig.sh --mode mac           relay in the laptop's network namespace: 127.0.0.1 there, host.docker.internal from the devcontainer
#   ./scripts/devices/rig.sh scripts/devices/scenarios/01-ask.json
#   --long                                        pair with the long invite instead of a short code
#   --prefix NAME                                 start container, network and image names with NAME (default two-devices)
#
# Exit code: 0 when every scenario ended as expected, 3 when the run finished
# but one or more did not, 130 when stopped by a signal, 1 otherwise.
#
# Needs: docker. Scenarios with live sessions need a Claude Code login in
#        ~/.claude/.credentials.json: a temporary copy is mounted read-only
#        into both devices and deleted when the run ends, however it ends.
# Time:  the run in results/20261118-v2-container (00 to 10) took 62 minutes.
# Cost:  model tokens for every scenario with a session. --no-sessions costs nothing.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
source scripts/smoke-lib.sh
export CPART_NO_BOOT=1

MODE=auto
PREFIX=two-devices
SESSIONS=1
OUT=
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE=$2; shift 2 ;;
    --prefix) PREFIX=$2; shift 2 ;;
    --no-sessions) SESSIONS=0; shift ;;
    --out) OUT=$2; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) args+=("$1"); shift ;;
  esac
done
case "$MODE" in auto|host|container|tunnel|mac) ;; *) fail "--mode is auto, host, container, tunnel or mac" ;; esac
case "$PREFIX" in *[!a-z0-9-]*|"") fail "--prefix takes lower-case letters, digits and dashes" ;; esac
OUT=${OUT:-scripts/devices/results/$(date -u +%Y%m%d-%H%M)-$MODE}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

rm -f "$OUT/results.json" "$OUT/report.md"
CREDS="$WORK/creds/credentials.json"
# Unique while this run's work directory exists, which is as long as the run.
RUN_ID=$(basename "$WORK" | tr -dc 'a-zA-Z0-9' | tail -c 6)
# Whatever happened: the copy of the login goes first, before smoke-lib keeps
# the work directory of a failed run, then anything of this run left in docker.
# A device still running would keep the login it had mounted, so say so.
remove_rig() {
  rm -rf "$WORK/creds"
  docker ps -aq --filter "name=^$PREFIX-$RUN_ID-(laptop|devcontainer|relay|relay2)\$" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$PREFIX-$RUN_ID" >/dev/null 2>&1 || true
  if [ -n "$(docker ps -aq --filter "name=^$PREFIX-$RUN_ID-" 2>/dev/null)" ]; then
    echo "WARNING: containers of this run are still there and may hold a copy of the Claude Code login. Remove them: docker rm -f \$(docker ps -aq --filter name=^$PREFIX-$RUN_ID-)" >&2
  fi
}
# The (exit $code) hands the code to smoke-lib's cleanup. Under set -e it
# would end the trap before cleanup ran, and the ERR trap would report it as a
# failing line, so both are off by then.
trap 'code=$?; trap - ERR; set +e; remove_rig; (exit $code); cleanup' EXIT

command -v docker >/dev/null || fail "this needs docker"
login=()
if [ "$SESSIONS" = 1 ]; then
  [ -r "$HOME/.claude/.credentials.json" ] || fail "no Claude Code login at ~/.claude/.credentials.json. Log in with claude, or use --no-sessions"
  # The devices get the access token without the refresh token. A refresh
  # from in there would rotate the refresh token and end the login on this
  # machine. So the access token must outlast the run, and run.ts starts no
  # session that would end after it.
  mkdir -m 700 "$WORK/creds"
  until=$(umask 077 && node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const o = c.claudeAiOauth;
    if (!o || !o.accessToken || !o.expiresAt) process.exit(3);
    delete o.refreshToken;
    fs.writeFileSync(process.argv[2], JSON.stringify(c), { mode: 0o600 });
    console.log(o.expiresAt);' "$HOME/.claude/.credentials.json" "$CREDS") || fail "could not read the Claude Code login at ~/.claude/.credentials.json"
  left=$(( (until / 1000 - $(date +%s)) / 60 ))
  [ "$left" -gt 30 ] || fail "the Claude Code login runs out in $left minutes. Start a claude session here to refresh it, then try again"
  login=(--laptop "$CREDS" --devcontainer "$CREDS" --login-until "$until")
fi

step "build the device image from this checkout"
mkdir -p "$WORK/ctx/counterpart"
# Not scripts/devices: the devices do not need the rig, and their sessions
# should not read it.
git ls-files -z --cached --others --exclude-standard | grep -zv '^scripts/devices/' | tar -C "$ROOT" --null -T - -cf - | tar -C "$WORK/ctx/counterpart" -xf -
cp -r scripts/devices/repos "$WORK/ctx/seed"
docker build -q -t "$PREFIX:latest" -f scripts/devices/Dockerfile "$WORK/ctx" >/dev/null

step "run the scenarios"
# In the background so that a signal to this script reaches run.ts too, and
# the cleanup waits for it: run.ts must not go on alone after the devices
# and the login are gone.
node scripts/devices/run.ts --work "$WORK" --out "$OUT" --image "$PREFIX:latest" --prefix "$PREFIX" --port "$PORT" --mode "$MODE" --id "$RUN_ID" \
  ${login[@]+"${login[@]}"} $([ "$SESSIONS" = 0 ] && echo --no-sessions) ${args[@]+"${args[@]}"} &
RUN_PID=$!
stopped=
trap 'stopped=1; kill -TERM "$RUN_PID" 2>/dev/null || true' TERM INT HUP
code=0
wait "$RUN_PID" || code=$?
# A trapped signal ends the wait early. Wait again until run.ts has exited.
while kill -0 "$RUN_PID" 2>/dev/null; do
  code=0
  wait "$RUN_PID" || code=$?
done
trap - TERM INT HUP
# Transcripts and logs stay next to the results; they are not committed.
mkdir -p "$OUT/logs"
cp -r "$WORK/sessions" "$OUT/logs/" 2>/dev/null || true
cp "$WORK"/*.log "$OUT/logs/" 2>/dev/null || true
[ -f "$OUT/report.md" ] && cat "$OUT/report.md"
[ -z "$stopped" ] || { echo "stopped by a signal. See $OUT" >&2; exit 130; }
[ "$code" = 0 ] || fail "the run stopped early (exit $code). See $OUT"
n=$(node -e 'const r=require(process.argv[1]); console.log(r.scenarios.filter(s=>s.ok).length, r.scenarios.length)' "$OUT/results.json")
ok=${n% *} all=${n#* }
echo
echo "TWO DEVICES RUN DONE: $ok of $all scenarios ended as expected. Results in $OUT"
# 3: the run finished, and at least one scenario did not end as expected.
[ "$ok" = "$all" ] || exit 3
