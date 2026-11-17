#!/usr/bin/env bash
# Pairing with a short code, as real processes: a relay, daemons, the CLI.
# Alice makes codes. Bob joins with no identity yet. Carol types a wrong word.
# Dave tries the right code after that. Erin already has an identity and uses
# the bare code. Frank joins while Alice's `cpart invite` waits in the foreground.
# Agent registration is skipped (--no-agents); nothing touches your real settings.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/smoke-lib.sh
export CPART_NO_BOOT=1
cpart() { local who=$1; shift; CPART_HOME="$WORK/$who" node packages/cli/src/main.ts "$@"; }
js() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s.trim().split("\n").pop());const p=process.argv[1];console.log(eval("v"+(p.startsWith("[")?"":".")+p))})' "$1"; }
stop_all() { for w in bob carol dave; do cpart "$w" down >/dev/null 2>&1 || true; done; }
# Keep the exit code: cleanup reads it to decide whether to print the logs.
trap 'c=$?; stop_all; (exit $c); cleanup' EXIT

step "a relay; alice and erin have identities and daemons"
start_relay
cpart alice init --relay "$RELAY" --no-passphrase >/dev/null
cpart erin init --relay "$RELAY" --no-passphrase >/dev/null
start_daemon alice
start_daemon erin

step "alice: cpart invite bob"
cpart alice invite bob --json --no-wait >"$WORK/invite1.json"
CODE=$(js code <"$WORK/invite1.json")
FULL=$(js full <"$WORK/invite1.json")
echo "code $CODE, line: $(js line <"$WORK/invite1.json")"
[[ "$CODE" =~ ^[0-9]{1,4}-[a-z]{3,5}-[a-z]{3,5}$ ]] || fail "not a short code: $CODE"
[ "$FULL" = "$CODE@$RELAY" ] || fail "the line does not name the relay: $FULL"
cpart alice status | tee "$WORK/alice.status1" | grep -q "code $CODE for bob works until" || fail "status does not show the code"

step "a misspelt word is caught before anything is sent"
TYPO=$(echo "$FULL" | sed -E 's/^([0-9]+)-[a-z]+/\1-qqqq/')
if cpart bob join "$TYPO" alice --yes --no-passphrase --no-agents >"$WORK/typo.out" 2>&1; then fail "a typo was accepted"; fi
grep -q "is not one of the code words" "$WORK/typo.out"
[ ! -e "$WORK/bob/keys.json" ] || fail "an identity was made for a typo"

step "bob, with no identity: cpart join <code@relay> alice"
cpart bob join "$FULL" alice --yes --no-passphrase --no-agents | tee "$WORK/bob.join"
grep -q "^ok  identity .* created" "$WORK/bob.join"
grep -q "^Paired with alice. The code proved who is on each side" "$WORK/bob.join"
wait_for "alice to see bob active" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts contacts | grep -q '^bob .*active'"
cpart alice status | tee "$WORK/alice.status2"
grep -q "paired with bob by code" "$WORK/alice.status2" || fail "alice's status does not say the pairing finished"
A=$(cpart alice contacts --json | js '[0].rootKey')
B=$(cpart bob whoami --json | js rootKey)
[ "$A" = "$B" ] || fail "alice holds a different key for bob"

step "they talk"
cpart bob open alice "short codes" >/dev/null
cpart bob say alice "hello from bob" >/dev/null
wait_for "alice to receive" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts log bob | grep -q 'hello from bob'"
cpart alice say bob "hello back" >/dev/null
wait_for "bob to receive" sh -c "CPART_HOME='$WORK/bob' node packages/cli/src/main.ts log alice | grep -q 'hello back'"

step "the same code again finds nothing"
if cpart carol join "$FULL" alice --yes --no-passphrase --no-agents >"$WORK/reuse.out" 2>&1; then fail "a used code paired again"; fi
grep -q "No code with that number" "$WORK/reuse.out"
cpart carol down >/dev/null 2>&1 || true
rm -rf "$WORK/carol"

step "carol types a wrong word: both sides told, code burned"
cpart alice invite carol --json --no-wait >"$WORK/invite2.json"
CODE2=$(js full <"$WORK/invite2.json")
W2=$(echo "$CODE2" | sed -E 's/^([0-9]+-[a-z]+)-([a-z]+)@/\2/')
OTHER=acid; [ "$W2" = acid ] && OTHER=zoom
WRONG=$(echo "$CODE2" | sed -E "s/^([0-9]+-[a-z]+)-[a-z]+@/\1-$OTHER@/")
if cpart carol join "$WRONG" alice --yes --no-passphrase --no-agents >"$WORK/carol.out" 2>&1; then fail "a wrong code paired"; fi
cat "$WORK/carol.out"
grep -q "The code did not match. Nothing was paired" "$WORK/carol.out"
cpart alice status | tee "$WORK/alice.status3"
grep -q "pairing for carol failed at .*Someone tried a wrong code" "$WORK/alice.status3" || fail "alice was not told"
[ "$(cpart carol contacts --json)" = "[]" ] || fail "carol got a contact"
cpart alice contacts | grep -q carol && fail "alice got a contact"
if cpart carol join "$WRONG" alice --yes --no-passphrase --no-agents >"$WORK/carol2.out" 2>&1; then fail "the same wrong code ran twice"; fi
grep -q "already tried here" "$WORK/carol2.out"

step "dave tries the right code after that: it is gone"
if cpart dave join "$CODE2" alice --yes --no-passphrase --no-agents >"$WORK/dave.out" 2>&1; then fail "a burned code paired"; fi
grep -q "No code with that number" "$WORK/dave.out"

step "erin already uses this relay: the bare code is enough"
cpart alice invite erin --json --no-wait >"$WORK/invite3.json"
cpart erin join "$(js code <"$WORK/invite3.json")" alice --no-agents | tee "$WORK/erin.join"
grep -q "^Paired with alice" "$WORK/erin.join"

step "a bare code with no identity says what is missing"
if cpart gina join "$(js code <"$WORK/invite3.json")" alice >"$WORK/gina.out" 2>&1; then fail "a bare code worked with no identity"; fi
grep -q "does not say which relay" "$WORK/gina.out"

step "alice's invite waits in the foreground and reports the result"
cpart alice invite frank >"$WORK/alice.wait" 2>&1 &
INV=$!
pids+=("$INV")
wait_for "the code to be printed" grep -q "^  cpart join " "$WORK/alice.wait"
cat "$WORK/alice.wait"
F=$(grep "^  cpart join " "$WORK/alice.wait" | awk '{print $3}')
cpart frank init --relay "$RELAY" --no-passphrase >/dev/null
start_daemon frank
cpart frank join "$F" alice --no-agents >"$WORK/frank.join"
wait "$INV"
cat "$WORK/alice.wait"
grep -q "^Paired with frank" "$WORK/alice.wait" || fail "the waiting invite did not report the pairing"

step "daemon logs"
grep "pairing" "$WORK/alice.log"

step "the relay database holds no code words"
for w in $(echo "$CODE" | tr '-' ' ' | cut -d' ' -f2-); do
  if grep -q "$w" "$WORK"/relay.db* 2>/dev/null; then fail "the relay stored the word $w"; fi
done

echo
echo "PAIRING SMOKE OK"
