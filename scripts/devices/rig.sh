#!/usr/bin/env bash
# Two devices that talk through Counterpart: "laptop" and "devcontainer", each
# a Docker container with its own disk, network namespace, CPART_HOME,
# Counterpart checkout (installed with install.sh), Claude Code and repo.
# Runs the scenarios in scripts/devices/scenarios and writes results.json and
# report.md. See scripts/devices/README.md.
#
#   ./scripts/devices/rig.sh                      every scenario, relay on this machine (or in a container if the firewall blocks that)
#   ./scripts/devices/rig.sh --mode tunnel        relay behind cpart relay --tunnel. Needs cloudflared
#   ./scripts/devices/rig.sh --no-sessions        only the scenarios that use no model (free, about ten minutes)
#   ./scripts/devices/rig.sh scripts/devices/scenarios/01-ask.json
#
# Needs docker. Scenarios with live sessions need a Claude Code login in
# ~/.claude/.credentials.json: a temporary copy is mounted read-only into both
# devices and deleted when the run ends, however it ends.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
source scripts/smoke-lib.sh
export CPART_NO_BOOT=1

MODE=auto
SESSIONS=1
OUT=
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE=$2; shift 2 ;;
    --no-sessions) SESSIONS=0; shift ;;
    --out) OUT=$2; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) args+=("$1"); shift ;;
  esac
done
case "$MODE" in auto|host|container|tunnel) ;; *) fail "--mode is auto, host, container or tunnel" ;; esac
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
  docker ps -aq --filter "name=^two-devices-$RUN_ID-(laptop|devcontainer|relay)\$" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "two-devices-$RUN_ID" >/dev/null 2>&1 || true
  if [ -n "$(docker ps -aq --filter "name=^two-devices-$RUN_ID-" 2>/dev/null)" ]; then
    echo "WARNING: containers of this run are still there and may hold a copy of the Claude Code login. Remove them: docker rm -f \$(docker ps -aq --filter name=^two-devices-$RUN_ID-)" >&2
  fi
}
trap 'code=$?; remove_rig; (exit $code); cleanup' EXIT

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
docker build -q -t two-devices:latest -f scripts/devices/Dockerfile "$WORK/ctx" >/dev/null

step "run the scenarios"
code=0
node scripts/devices/run.ts --work "$WORK" --out "$OUT" --image two-devices:latest --port "$PORT" --mode "$MODE" --id "$RUN_ID" \
  ${login[@]+"${login[@]}"} $([ "$SESSIONS" = 0 ] && echo --no-sessions) ${args[@]+"${args[@]}"} || code=$?
# Transcripts and logs stay next to the results; they are not committed.
mkdir -p "$OUT/logs"
cp -r "$WORK/sessions" "$OUT/logs/" 2>/dev/null || true
cp "$WORK"/*.log "$OUT/logs/" 2>/dev/null || true
[ -f "$OUT/report.md" ] && cat "$OUT/report.md"
[ "$code" = 0 ] || fail "the run stopped early (exit $code). See $OUT"
n=$(node -e 'const r=require(process.argv[1]); console.log(r.scenarios.filter(s=>s.ok).length + " of " + r.scenarios.length)' "$OUT/results.json")
echo
echo "TWO DEVICES RUN DONE: $n scenarios ended as expected. Results in $OUT"
