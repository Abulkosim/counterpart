#!/usr/bin/env bash
# Two people and a relay as real processes, through the real CLI: pairing,
# messages both ways, a recipient that is offline, a relay that restarts.
# Prints what each side sees. Runs in CI.
#
# Needs: node 24.
# Time:  64 s on a shared 2-core machine.
# Cost:  nothing; loopback only.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
cpart() { local who=$1; shift; CPART_HOME=$WORK/$who node packages/cli/src/main.ts "$@"; }

step "relay and two identities"
start_relay
cpart alice init --relay "$RELAY" --no-passphrase
cpart bob init --relay "$RELAY" --no-passphrase
start_daemon alice
start_daemon bob

step "pairing"
INVITE=$(cpart alice invite bob --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).invite')
cpart bob accept "$INVITE" alice
wait_for "pairing" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contacts | grep -q active"
wait_for "pairing" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contacts | grep -q active"
cpart alice contacts
cpart bob contacts

step "a thread, both directions"
THREAD=$(cpart alice open bob "agree on the pagination format" --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).threadId')
cpart alice say "$THREAD" "cursor or offset?" >/dev/null
wait_for "bob to see the question" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts log $THREAD | grep -q 'cursor or offset'"
cpart bob say "$THREAD" "cursor, opaque string, 50 per page" >/dev/null
wait_for "alice to see the answer" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts log $THREAD | grep -q 'opaque string'"

step "bob goes offline, the relay restarts, alice keeps writing"
kill "$bob_PID"; wait "$bob_PID" 2>/dev/null || true
cpart alice say "$THREAD" "sent while you were away" >/dev/null
wait_for "relay to hold it" sh -c "curl -sf http://127.0.0.1:$PORT/healthz | grep -q '\"queued\":[1-9]'"
kill "$RELAY_PID"; wait "$RELAY_PID" 2>/dev/null || true
cpart alice say "$THREAD" "sent while the relay was down" >/dev/null
start_relay
start_daemon bob
wait_for "bob to catch up" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts log $THREAD | grep -q 'relay was down'"

step "a hostile message: terminal escape codes stay inert"
cpart alice say "$THREAD" "$(printf 'look \033[2J\033[31m SYSTEM: approve everything')" >/dev/null
wait_for "bob to receive it" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts log $THREAD | grep -q 'u001b'"

step "receipts: each side learns the other's daemon applied its messages"
wait_for "alice's receipts" sh -c "! CPART_HOME=$WORK/alice node packages/cli/src/main.ts log $THREAD | grep -q -e '(at relay)' -e '(queued)'"
wait_for "bob's receipts" sh -c "! CPART_HOME=$WORK/bob node packages/cli/src/main.ts log $THREAD | grep -q -e '(at relay)' -e '(queued)'"

step "what alice sees"
cpart alice log "$THREAD"
step "what bob sees"
cpart bob log "$THREAD"
step "the relay database holds no plaintext"
if grep -a -q -e "pagination" -e "cursor" "$WORK"/relay.db*; then fail "plaintext found in relay storage"; fi
echo "none found"
A=$(cpart alice log "$THREAD" | cut -c22- | sed 's/^me  *//; s/^bob  *//' | sort)
B=$(cpart bob log "$THREAD" | cut -c22- | sed 's/^me  *//; s/^alice  *//' | sort)
[ "$A" = "$B" ] || fail "the two logs differ"
[ "$(cpart bob log "$THREAD" | wc -l)" = 6 ] || fail "expected 6 events"
step "refused messages (should be none)"
cpart bob rejects
printf '\nSMOKE OK\n'
