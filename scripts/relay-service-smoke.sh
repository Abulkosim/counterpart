#!/usr/bin/env bash
# A relay run as a service, the way someone keeps one on their own machine:
# `cpart relay --boot` writes a systemd user unit, two people pair through it
# (one of them with --no-agents), a message waits in the relay while the relay
# is killed and started again by systemd, and `cpart relay --no-boot` removes it.
# Also: the default database is in the relay home, not in the directory the
# relay was started from. Needs a systemd user session (systemctl --user); a
# Mac's launchd is not run here. Nothing touches ~/.counterpart or your agents.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/smoke-lib.sh
unset CPART_NO_AUTOSTART
export CPART_NO_BOOT=1 CPART_RELAY_HOME=$WORK/relay-home
REPO=$PWD
cpart() { local who=$1; shift; CPART_HOME="$WORK/$who" node "$REPO/packages/cli/src/main.ts" "$@"; }
js() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s.trim().split("\n").pop());console.log(v[process.argv[1]])})' "$1"; }
UNIT=
stop_all() {
  for w in alice bob; do cpart "$w" down >/dev/null 2>&1 || true; done
  node packages/cli/src/main.ts relay --no-boot --port "$PORT" >/dev/null 2>&1 || true
}
trap 'c=$?; stop_all; (exit $c); cleanup' EXIT

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "SKIP: no systemd user session here, so the service was not run. packages/cli/test/cli.test.ts checks the unit text."
  exit 0
fi

step "cpart relay in a project directory keeps its database in the relay home"
mkdir -p "$WORK/project"
(cd "$WORK/project" && exec node "$REPO/packages/cli/src/main.ts" relay --port "$PORT") >"$WORK/fg.log" 2>&1 &
FG=$!
pids+=("$FG")
wait_for "the relay in the foreground" grep -q "relay listening" "$WORK/fg.log"
grep -q "^database $CPART_RELAY_HOME/relay-$PORT.db$" "$WORK/fg.log" || fail "the relay did not say where its database is: $(cat "$WORK/fg.log")"
[ -e "$CPART_RELAY_HOME/relay-$PORT.db" ] || fail "no database in the relay home"
[ -z "$(ls "$WORK/project")" ] || fail "the relay wrote into the directory it was started from: $(ls "$WORK/project")"
[ "$(stat -c %a "$CPART_RELAY_HOME")" = 700 ] || fail "the relay home is not private: $(stat -c %a "$CPART_RELAY_HOME")"

step "a relay.db left by an older version is pointed out"
kill "$FG"; wait "$FG" 2>/dev/null || true
touch "$WORK/project/relay.db"
(cd "$WORK/project" && exec node "$REPO/packages/cli/src/main.ts" relay --port "$PORT") >"$WORK/fg2.log" 2>&1 &
FG=$!
pids+=("$FG")
wait_for "the relay in the foreground again" grep -q "relay listening" "$WORK/fg2.log"
grep -q "There is a relay.db in this directory, from an older version" "$WORK/fg2.log"
grep -q -- "--db relay.db" "$WORK/fg2.log"
kill "$FG"; wait "$FG" 2>/dev/null || true

step "cpart relay --boot"
env -u CPART_NO_BOOT node packages/cli/src/main.ts relay --boot --port "$PORT" | tee "$WORK/boot.out"
grep -q "^Relay running at ws://127.0.0.1:$PORT. It starts at login" "$WORK/boot.out"
grep -q "reaches it at ws://host.docker.internal:$PORT" "$WORK/boot.out"
grep -q "^Database: $CPART_RELAY_HOME/relay-$PORT.db$" "$WORK/boot.out"
UNIT=$(grep -l "\"--port\" \"$PORT\"" ~/.config/systemd/user/cpart-relay-*.service | head -1)
UNIT=$(basename "$UNIT" .service)
[ "$(systemctl --user is-active "$UNIT")" = active ] || fail "$UNIT is not active"
[ "$(systemctl --user is-enabled "$UNIT")" = enabled ] || fail "$UNIT is not enabled to start at login"
ID=$(curl -sf "http://127.0.0.1:$PORT/healthz" | js id)
echo "unit $UNIT, relay id $ID"

step "a second --boot on the same port replaces it, keeping the database"
env -u CPART_NO_BOOT node packages/cli/src/main.ts relay --boot --port "$PORT" | tee "$WORK/boot2.out"
grep -q "^Relay service replaced at" "$WORK/boot2.out"
[ "$(curl -sf "http://127.0.0.1:$PORT/healthz" | js id)" = "$ID" ] || fail "the relay id changed, so the database did"

step "a --boot that cannot start puts the service that ran before back"
if env -u CPART_NO_BOOT node packages/cli/src/main.ts relay --boot --port "$PORT" --host 10.254.254.254 >"$WORK/badboot.out" 2>&1; then fail "--boot on an address this machine does not have succeeded"; fi
cat "$WORK/badboot.out"
grep -q "The service that ran before is back, unchanged." "$WORK/badboot.out" || fail "a failed --boot did not say the old service is back"
[ "$(systemctl --user is-active "$UNIT")" = active ] || fail "a failed --boot left $UNIT stopped"
[ "$(curl -sf "http://127.0.0.1:$PORT/healthz" | js id)" = "$ID" ] || fail "the relay that ran before does not answer after a failed --boot"

step "a relay in a terminal on the same port is told about the service"
if node packages/cli/src/main.ts relay --port "$PORT" >"$WORK/clash.out" 2>&1; then fail "a second relay started on a busy port"; fi
grep -q "A relay service runs on port $PORT already" "$WORK/clash.out"

step "status shows the service, with or without an identity"
cpart nobody status | tee "$WORK/nobody.status"
grep -q "^Service   relay on port $PORT starts at login (systemd), answering" "$WORK/nobody.status"

step "alice sets up on it; bob joins with a code and --no-agents"
cpart alice setup --relay "ws://127.0.0.1:$PORT" --no-agents --no-passphrase >/dev/null
cpart alice status | grep -q "^Service   relay on port $PORT starts at login (systemd), answering" || fail "status does not show the relay service"
cpart alice invite bob --json --code >"$WORK/invite.json"
FULL=$(js full <"$WORK/invite.json")
cpart bob join "$FULL" alice --yes --no-agents --no-passphrase | tee "$WORK/bob.join"
grep -q "^Paired with alice" "$WORK/bob.join"
if grep -q "in Claude Code or Codex, say" "$WORK/bob.join"; then fail "join --no-agents still pointed at Claude Code or Codex"; fi
grep -q "cpart open alice" "$WORK/bob.join" || fail "join --no-agents did not say how to talk from the terminal"

step "a message waits in the relay while systemd restarts it"
cpart alice down >/dev/null
cpart bob open alice "relay restart" --say "sent while alice was away" >/dev/null
wait_for "the message to wait at the relay" sh -c "[ \$(curl -sf http://127.0.0.1:$PORT/healthz | node -pe 'JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")).queued') -gt 0 ]"
cpart bob down >/dev/null
OLD=$(systemctl --user show -p MainPID --value "$UNIT")
kill "$OLD"
wait_for "systemd to start the relay again" sh -c "[ \"\$(systemctl --user show -p MainPID --value $UNIT)\" != $OLD ] && [ \"\$(systemctl --user show -p MainPID --value $UNIT)\" != 0 ] && curl -sf http://127.0.0.1:$PORT/healthz"
echo "relay pid $OLD killed; systemd started $(systemctl --user show -p MainPID --value "$UNIT")"
[ "$(curl -sf "http://127.0.0.1:$PORT/healthz" | js id)" = "$ID" ] || fail "the restarted relay has another database"
cpart alice up >/dev/null
wait_for "alice to get the message that waited" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts log bob | grep -q 'sent while alice was away'"
cpart alice down >/dev/null

step "cpart relay --no-boot"
node packages/cli/src/main.ts relay --no-boot | tee "$WORK/noboot.out"
grep -q "^Stopped the relay service on port $PORT" "$WORK/noboot.out"
[ ! -e ~/.config/systemd/user/"$UNIT".service ] || fail "the unit file is still there"
if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then fail "the relay still answers"; fi
[ -e "$CPART_RELAY_HOME/relay-$PORT.db" ] || fail "the database was removed"
if cpart alice status | grep -q "^Service"; then fail "status still shows a relay service"; fi
node packages/cli/src/main.ts relay --no-boot | grep -q "No relay service is installed here."

echo
echo "RELAY SERVICE SMOKE OK"
