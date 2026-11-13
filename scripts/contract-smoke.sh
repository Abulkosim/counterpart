#!/usr/bin/env bash
# Two people reach a signed agreement using only the real CLI: propose, revise,
# approve on both sides, export, verify, and check that tampering and a wrong
# passphrase are refused. No models involved.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/smoke-lib.sh
ALICE_PASS=alice-correct-horse
BOB_PASS=bob-battery-staple

cpart() { local who=$1 pass=$2; shift 2; CPART_HOME=$WORK/$who CPART_PASSPHRASE=$pass node packages/cli/src/main.ts "$@"; }
alice() { cpart alice "$ALICE_PASS" "$@"; }
bob() { cpart bob "$BOB_PASS" "$@"; }
field() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
must_fail() {
  local what=$1; shift
  if "$@" >"$WORK/out.txt" 2>&1; then fail "$what was accepted"; fi
  echo "refused, as it should be: $(tail -1 "$WORK/out.txt")"
}

start_relay
alice init --relay "$RELAY" >/dev/null
bob init --relay "$RELAY" >/dev/null
start_daemon alice
start_daemon bob
bob accept "$(alice invite bob --json | field .invite)" alice >/dev/null
wait_for "pairing" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contacts | grep -q active"
wait_for "pairing" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contacts | grep -q active"

step "alice proposes"
THREAD=$(alice open bob "agree on orders pagination" --json | field .threadId)
cat >"$WORK/v1.md" <<'DOC'
GET /v2/orders returns orders newest first.
Pagination uses an opaque `cursor`. Maximum `limit` is 100.
The server ships this by 2026-12-01. The client stops using offsets the same day.
DOC
echo '{"type":"object","required":["data","next_cursor"],"properties":{"next_cursor":{"type":["string","null"]}}}' >"$WORK/page.schema.json"
H1=$(alice propose "$THREAD" --title "Orders pagination" --file "$WORK/v1.md" --part "json-schema:$WORK/page.schema.json" --json | field .proposalId)
wait_for "bob to see it" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contracts $THREAD | grep -q open"

step "bob counters with a larger page size"
sed 's/is 100/is 200/' "$WORK/v1.md" >"$WORK/v2.md"
H2=$(bob propose "$THREAD" --title "Orders pagination" --file "$WORK/v2.md" --part "json-schema:$WORK/page.schema.json" --supersedes "${H1:0:10}" --json | field .proposalId)
wait_for "alice to see it" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contracts $THREAD | grep -q superseded"
alice contracts "$THREAD"

step "what alice is shown before she signs"
alice approve "$THREAD" "${H2:0:8}" --yes

step "a wrong passphrase signs nothing"
must_fail "a wrong passphrase" env CPART_HOME="$WORK/bob" CPART_PASSPHRASE=not-bobs-passphrase node packages/cli/src/main.ts approve "$THREAD" "${H2:0:8}" --yes
must_fail "an export before both signed" bob agreement export "$THREAD" "${H2:0:8}"

step "bob signs the same text"
wait_for "bob to see alice's approval" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contracts $THREAD | grep -q 'agreed\|signed: -- them'"
bob approve "$THREAD" "${H2:0:8}" --yes 2>/dev/null
wait_for "alice to see the agreement" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contracts $THREAD | grep -q agreed"
alice contracts "$THREAD"

step "both export; the files are identical and verify with no database"
alice agreement export "$THREAD" "${H2:0:8}" --out "$WORK/alice-agreement.json" >/dev/null
bob agreement export "$THREAD" "${H2:0:8}" --out "$WORK/bob-agreement.json" >/dev/null
cmp "$WORK/alice-agreement.json" "$WORK/bob-agreement.json" || fail "the two exports differ"
CPART_HOME=$WORK/nobody node packages/cli/src/main.ts agreement verify "$WORK/alice-agreement.json"

step "one changed character breaks it"
sed 's/is 200/is 201/' "$WORK/alice-agreement.json" >"$WORK/tampered.json"
must_fail "a tampered agreement" node packages/cli/src/main.ts agreement verify "$WORK/tampered.json"

step "the thread, as bob sees it"
bob log "$THREAD"
printf '\nCONTRACT SMOKE OK\n'
