#!/usr/bin/env bash
# Loses a message for real and watches the thread recover. Relay and two
# daemons are separate processes. While Bob is offline, one of Alice's
# messages is deleted from the relay's database, as if it had expired there.
# Bob holds the message that depends on it, asks Alice for the missing one,
# and Alice sends it again.
set -euo pipefail
# This script starts its own daemons.
export CPART_NO_AUTOSTART=1
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
PORT=${PORT:-7463}
RELAY=ws://127.0.0.1:$PORT
# Bob asks for missing parents after 5 seconds instead of 30, so the held state can be seen and the run stays short.
export CPART_RESEND_AFTER_MS=5000
cpart() { local who=$1; shift; CPART_HOME=$WORK/$who node packages/cli/src/main.ts "$@"; }
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
wait_for() { # wait_for <description> <command...>
  local what=$1; shift
  for _ in $(seq 1 200); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.1; done
  fail "timed out waiting for $what"
}
field() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }
# relay_sql <sql> <param>: run one statement against the relay's database from outside the relay.
relay_sql() { node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000"); const s = db.prepare(process.argv[2]); const r = /^select/i.test(process.argv[2]) ? s.get(process.argv[3]) : s.run(process.argv[3]); console.log(r.n ?? r.changes);' "$WORK/relay.db" "$1" "$2" 2>/dev/null; }
at_relay() { [ "$(relay_sql 'SELECT COUNT(*) AS n FROM mailbox WHERE id = ?' "$1")" = 1 ]; }
delivery() { cpart "$1" log "$THREAD" --json | node -pe "JSON.parse(require('fs').readFileSync(0)).find((e) => e.id === '$2')?.delivery"; }
start_daemon() { CPART_HOME=$WORK/$1 node packages/cli/src/main.ts daemon >>"$WORK/$1.log" 2>&1 & eval "$1_PID=$!"; pids+=("$!"); wait_for "$1 daemon" grep -q connected "$WORK/$1.log"; }

step "relay and two identities"
node packages/cli/src/main.ts relay --port "$PORT" --db "$WORK/relay.db" >"$WORK/relay.log" 2>&1 &
pids+=("$!")
wait_for "relay" curl -sf "http://127.0.0.1:$PORT/healthz"
cpart alice init --relay "$RELAY" --no-passphrase
cpart bob init --relay "$RELAY" --no-passphrase
start_daemon alice
start_daemon bob

step "pairing and a first message"
INVITE=$(cpart alice invite bob --json | field invite)
cpart bob accept "$INVITE" alice
wait_for "pairing" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contacts | grep -q active"
wait_for "pairing" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contacts | grep -q active"
THREAD=$(cpart alice open bob "agree on the retry policy" --json | field threadId)
FIRST=$(cpart alice say "$THREAD" "first, while you are online" --json | field id)
wait_for "bob to see it" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts log $THREAD | grep -q 'while you are online'"

step "the sender's view: stored by the relay, then received by bob"
wait_for "bob's receipt" sh -c "[ \"\$(CPART_HOME=$WORK/alice node packages/cli/src/main.ts log $THREAD --json | node -pe \"JSON.parse(require('fs').readFileSync(0)).find((e) => e.id === '$FIRST').delivery\")\" = received ]"
echo "alice's first message: $(delivery alice "$FIRST")"
wait_for "the mailbox to drain" sh -c "curl -sf http://127.0.0.1:$PORT/healthz | grep -q '\"queued\":0'"

step "bob goes offline, alice writes twice, the relay loses the first of the two"
kill "$bob_PID"; wait "$bob_PID" 2>/dev/null || true
LOST=$(cpart alice say "$THREAD" "second, the relay will lose this" --json | field id)
NEXT=$(cpart alice say "$THREAD" "third, depends on the second" --json | field id)
wait_for "relay to hold both" sh -c "curl -sf http://127.0.0.1:$PORT/healthz | grep -q '\"queued\":2'"
at_relay "$LOST" || fail "the relay does not hold the message that is about to be lost"
[ "$(relay_sql 'DELETE FROM mailbox WHERE id = ?' "$LOST")" = 1 ] || fail "could not delete the message from the relay"
at_relay "$LOST" && fail "the message is still at the relay"
at_relay "$NEXT" || fail "the later message is gone too"
echo "deleted $LOST from the relay's mailbox; $NEXT is still there"
echo "alice still believes: second is '$(delivery alice "$LOST")', third is '$(delivery alice "$NEXT")'"
[ "$(delivery alice "$LOST")" = stored ] || fail "expected alice to see the lost message as stored"

step "bob returns: the third message is held, the second never came"
: >"$WORK/bob.log"; start_daemon bob
# One reading of the log has to show both facts, so it is captured once per try.
HELD=""
for _ in $(seq 1 100); do
  HELD=$(cpart bob log "$THREAD")
  case $HELD in *"(held) third"*) break ;; esac
  case $HELD in *"relay will lose"*) fail "bob got the lost message before the held state was seen" ;; esac
  sleep 0.1
done
echo "$HELD"
case $HELD in *"(held) third"*) ;; *) fail "bob never showed the third message as held" ;; esac
case $HELD in *"relay will lose"*) fail "bob has the lost message while the third is still held" ;; esac

step "bob asks, alice sends it again, the thread recovers"
wait_for "bob to recover" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts log $THREAD | grep -q 'relay will lose'"
wait_for "nothing held" sh -c "! CPART_HOME=$WORK/bob node packages/cli/src/main.ts log $THREAD | grep -q '(held)'"
cpart bob log "$THREAD"
[ "$(cpart bob log "$THREAD" | wc -l)" = 4 ] || fail "expected 4 events in bob's log"
cpart bob say "$THREAD" "got all three" >/dev/null
wait_for "alice to see the reply" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts log $THREAD | grep -q 'got all three'"

step "receipts: every message ends as received on the side that sent it"
wait_for "alice's receipts" sh -c "! CPART_HOME=$WORK/alice node packages/cli/src/main.ts log $THREAD | grep -q -e '(at relay)' -e '(queued)'"
wait_for "bob's receipt" sh -c "! CPART_HOME=$WORK/bob node packages/cli/src/main.ts log $THREAD | grep -q -e '(at relay)' -e '(queued)'"
echo "second is '$(delivery alice "$LOST")', third is '$(delivery alice "$NEXT")'"
[ "$(delivery alice "$LOST")" = received ] || fail "the resent message was not confirmed"

step "what alice sees"
cpart alice log "$THREAD"
step "what bob sees"
cpart bob log "$THREAD"
A=$(cpart alice log "$THREAD" | cut -c22- | sed 's/^me  *//; s/^bob  *//' | sort)
B=$(cpart bob log "$THREAD" | cut -c22- | sed 's/^me  *//; s/^alice  *//' | sort)
[ "$A" = "$B" ] || fail "the two logs differ"
# The request and the receipts are not thread events: five lines, nothing else.
[ "$(cpart alice log "$THREAD" | wc -l)" = 5 ] || fail "expected 5 events in alice's log"
step "refused messages on either side (should be none)"
cpart alice rejects
cpart bob rejects
[ "$(cpart alice rejects --json)" = "[]" ] || fail "alice refused something"
[ "$(cpart bob rejects --json)" = "[]" ] || fail "bob refused something"
wait_for "the mailbox to drain" sh -c "curl -sf http://127.0.0.1:$PORT/healthz | grep -q '\"queued\":0'"
printf '\nRESEND SMOKE OK\n'
