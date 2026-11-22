#!/usr/bin/env bash
# Pairing with a short code. Alice makes codes. Bob joins with no identity
# yet. Carol types a wrong word. Dave tries the right code after that. Erin
# already has an identity and uses the bare code. Frank joins while Alice's
# `cpart invite` waits in the foreground. Uses --no-agents, so nothing touches
# your real agent settings.
#
# Needs: node 24.
# Cost:  nothing; loopback only.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/smoke-lib.sh
export CPART_NO_BOOT=1
cpart() { local who=$1; shift; CPART_HOME="$WORK/$who" node packages/cli/src/main.ts "$@"; }
js() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s.trim().split("\n").pop());const p=process.argv[1];console.log(eval("v"+(p.startsWith("[")?"":".")+p))})' "$1"; }
stop_all() { for w in bob carol dave henry; do cpart "$w" down >/dev/null 2>&1 || true; done; }
# Keep the exit code: cleanup reads it to decide whether to print the logs.
trap 'c=$?; stop_all; (exit $c); cleanup' EXIT

step "a relay; alice and erin have identities and daemons"
start_relay
cpart alice init --relay "$RELAY" --no-passphrase >/dev/null
cpart erin init --relay "$RELAY" --no-passphrase >/dev/null
start_daemon alice
start_daemon erin

step "alice: cpart invite bob"
cpart alice invite bob --json --code >"$WORK/invite1.json"
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
# --no-agents: no agent has the tools, so the hint is the terminal one.
if grep -q "in Claude Code or Codex, say" "$WORK/bob.join"; then fail "join --no-agents pointed at Claude Code or Codex"; fi
grep -q 'cpart open alice "<what it is about>"' "$WORK/bob.join" || fail "join --no-agents did not say how to talk from the terminal"
wait_for "alice to see bob active" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts contacts | grep -q '^bob .*active'"
cpart alice status | tee "$WORK/alice.status2"
grep -q "paired with bob by code" "$WORK/alice.status2" || fail "alice's status does not say the pairing finished"
# It is news, not something to do.
sed -n '/^Lately:/,$p' "$WORK/alice.status2" | grep -q "paired with bob by code" || fail "the pairing is not under Lately"
if sed -n '/^Waiting for you:/,/^$/p' "$WORK/alice.status2" | grep -q "paired with"; then fail "the pairing is listed as waiting for you"; fi
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
cpart alice invite carol --json --code >"$WORK/invite2.json"
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
cpart alice invite erin --json --code >"$WORK/invite3.json"
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

step "the long invite still works, and --json without --code still gives it"
LONG=$(cpart alice invite zed --json | js invite)
[[ "$LONG" == cpart-invite:* ]] || fail "--json no longer gives the long invite"
cpart alice invite yan --long | grep -q "cpart join cpart-invite:" || fail "--long did not print a long invite"

step "a name that cannot be a contact name is refused before a code is made or spent"
if cpart alice invite Maya --json --code >"$WORK/badname.out" 2>&1; then fail "an invite for Maya was made"; fi
grep -q "contact names are" "$WORK/badname.out"
cpart alice status | grep -q "for Maya" && fail "a code for Maya is live"
cpart alice invite ivan --json --code >"$WORK/invite5.json"
if cpart erin join "$(js code <"$WORK/invite5.json")" Alice --no-agents >"$WORK/badname2.out" 2>&1; then fail "a join as Alice ran"; fi
grep -q "contact names are" "$WORK/badname2.out"
cpart alice status | grep -q "code $(js code <"$WORK/invite5.json") for ivan works until .*[0-9]$" || fail "the code was spent by a bad name"

step "the words are not left in pairing.db or its log after a pairing"
for f in "$WORK"/alice/pairing.db* "$WORK"/bob/pairing.db*; do
  if grep -aq "$(echo "$CODE" | cut -d- -f2-)" "$f"; then fail "the words of $CODE are still in $f"; fi
done

step "alice's daemon is killed during a pairing: the joiner hears at once, not after ten minutes"
cpart alice invite henry --json --code >"$WORK/invite4.json"
kill -9 "$alice_PID"
start_daemon alice
cpart alice status | grep -q "pairing for henry failed at .*The daemon restarted" || fail "alice's status does not say the restart ended it"
T0=$(date +%s)
if cpart henry join "$(js full <"$WORK/invite4.json")" alice --yes --no-passphrase --no-agents >"$WORK/henry.out" 2>&1; then fail "a code from before the restart paired"; fi
cat "$WORK/henry.out"
grep -Eq "No code with that number|The other side ended the pairing" "$WORK/henry.out" || fail "henry was not told"
[ $(( $(date +%s) - T0 )) -lt 60 ] || fail "henry waited $(( $(date +%s) - T0 ))s"

step "daemon logs"
grep "pairing" "$WORK/alice.log"

step "the relay database holds no code words"
for w in $(echo "$CODE" | tr '-' ' ' | cut -d' ' -f2-); do
  if grep -q "$w" "$WORK"/relay.db* 2>/dev/null; then fail "the relay stored the word $w"; fi
done

echo
echo "PAIRING SMOKE OK"
