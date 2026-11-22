#!/usr/bin/env bash
# Two people sign a contract, then one tells the other what their repository
# holds. First the bound file matches the signed text and the receiver shows it
# as checked. Then one byte changes on a new commit: the receiver shows the
# mismatch and marks the first evidence stale. Runs in CI.
#
# Needs: node 24, git.
# Time:  32 s on a shared 2-core machine.
# Cost:  nothing; no model, loopback only.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
ALICE_PASS=alice-correct-horse
BOB_PASS=bob-battery-staple

cpart() { local who=$1 pass=$2; shift 2; CPART_HOME=$WORK/$who CPART_PASSPHRASE=$pass node packages/cli/src/main.ts "$@"; }
alice() { cpart alice "$ALICE_PASS" "$@"; }
bob() { cpart bob "$BOB_PASS" "$@"; }
field() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
g() { git -C "$WORK/repo" -c user.name=alice -c user.email=alice@example.com -c commit.gpgsign=false "$@"; }
must_fail() {
  local what=$1; shift
  if "$@" >"$WORK/out.txt" 2>&1; then fail "$what was accepted"; fi
  echo "refused, as it should be: $(tail -1 "$WORK/out.txt")"
}
# How many pieces of evidence bob holds in the thread.
bob_has() { [ "$(bob evidence "$THREAD" --json | field .length)" = "$1" ]; }

start_relay
alice init --relay "$RELAY" >/dev/null
bob init --relay "$RELAY" >/dev/null
start_daemon alice
start_daemon bob
bob accept "$(alice invite bob --json | field .invite)" alice >/dev/null
wait_for "pairing" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contacts | grep -q active"
wait_for "pairing" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contacts | grep -q active"

step "alice and bob sign a contract with one schema attached"
THREAD=$(alice open bob "agree on orders pagination" --json | field .threadId)
echo "GET /v2/orders pages with an opaque cursor. The response follows the attached schema." >"$WORK/contract.md"
printf '{"type":"object","required":["data","next_cursor"],"properties":{"next_cursor":{"type":["string","null"]}}}\n' >"$WORK/page.schema.json"
P=$(alice propose "$THREAD" --title "Orders pagination" --file "$WORK/contract.md" --part "json-schema:$WORK/page.schema.json" --json | field .proposalId)
wait_for "bob to see it" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contracts $THREAD | grep -q open"

step "evidence before the agreement is refused"
mkdir -p "$WORK/repo"
git -C "$WORK/repo" init -q -b main
must_fail "evidence for a proposal nobody signed" alice evidence send "$THREAD" "${P:0:8}" --repo "$WORK/repo"

alice approve "$THREAD" "${P:0:8}" --yes >/dev/null 2>&1
wait_for "bob to see alice's approval" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contracts $THREAD | grep -q 'signed: -- them'"
bob approve "$THREAD" "${P:0:8}" --yes >/dev/null 2>&1
wait_for "alice to see the agreement" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contracts $THREAD | grep -q agreed"

step "alice ties her repository to the agreement on main"
g remote add origin https://github.com/alice/orders-api.git
alice repo init "$THREAD" "${P:0:8}" --repo "$WORK/repo" --bind page.schema.json=schemas/page.schema.json >/dev/null
g add -A
g commit -q -m "chore: trust the orders agreement"

step "her change carries the signed schema; she sends evidence"
g checkout -q -b change
mkdir -p "$WORK/repo/schemas"
cp "$WORK/page.schema.json" "$WORK/repo/schemas/page.schema.json"
g add -A
g commit -q -m "feat: add the agreed schema"
HEAD1=$(g rev-parse HEAD)
alice evidence send "$THREAD" "${P:0:8}" --repo "$WORK/repo" --pr https://github.com/alice/orders-api/pull/7 --run https://github.com/alice/orders-api/actions/runs/1 --status success

step "an address that is not https never leaves alice's machine"
must_fail "a javascript: address" alice evidence send "$THREAD" "${P:0:8}" --repo "$WORK/repo" --pr "javascript:alert(1)"

step "what bob sees: the part is checked, the rest is alice's claim"
wait_for "the evidence to reach bob" bob_has 1
bob evidence "$THREAD" | tee "$WORK/bob1.txt"
grep -q "ok        page.schema.json at schemas/page.schema.json: the digest sent is the signed part's" "$WORK/bob1.txt" || fail "bob does not show the part as checked"
grep -q "alice's claim, not checked here" "$WORK/bob1.txt" || fail "bob does not label the claim"
grep -q "from alice's side.*: current" "$WORK/bob1.txt" || fail "the evidence is not current"
[ "$(bob evidence "$THREAD" --json | field '[0].checked.partsMatch')" = "true" ] || fail "partsMatch is not true"

step "alice changes one byte of the bound file and sends evidence again"
sed -i.bak 's/next_cursor"\]/next_cursor" ]/' "$WORK/repo/schemas/page.schema.json"
rm "$WORK/repo/schemas/page.schema.json.bak"
if cmp -s "$WORK/page.schema.json" "$WORK/repo/schemas/page.schema.json"; then fail "the file did not change"; fi
g add -A
g commit -q -m "fix: reformat the schema"
alice evidence send "$THREAD" "${P:0:8}" --repo "$WORK/repo" --pr https://github.com/alice/orders-api/pull/7 >/dev/null

step "what bob sees now: a mismatch, and the first evidence is stale"
wait_for "the second evidence to reach bob" bob_has 2
bob evidence "$THREAD" "${P:0:8}" | tee "$WORK/bob2.txt"
grep -q "MISMATCH  page.schema.json at schemas/page.schema.json: the digest sent" "$WORK/bob2.txt" || fail "bob does not show the mismatch"
grep -q "STALE (head changed since)" "$WORK/bob2.txt" || fail "the first evidence is not stale"
bob evidence "$THREAD" --json >"$WORK/bob2.json"
[ "$(field '.filter((v) => v.state === "current").length' <"$WORK/bob2.json")" = "1" ] || fail "more than one current evidence"
[ "$(field '.find((v) => v.state === "current").checked.partsMatch' <"$WORK/bob2.json")" = "false" ] || fail "the current evidence should not match"
[ "$(field '.find((v) => v.state === "stale").claim.head' <"$WORK/bob2.json")" = "$HEAD1" ] || fail "the stale evidence is not the first one"

step "the thread, as bob sees it, and what he refused"
bob log "$THREAD"
bob rejects
printf '\nEVIDENCE SMOKE OK\n'
