#!/usr/bin/env bash
# From agreement to a verified pull request, on GitHub. Two people sign a
# contract; Alice's worker proposes the change; she publishes it; a workflow on
# her main branch checks the pull request carries what was signed. Then one
# byte of the schema is changed and the check fails.
#
# This creates a PRIVATE repository under your GitHub account and leaves it
# there so you can look at it. It uses a real model. Not for CI.
#
#   ./scripts/demo-publish.sh
set -euo pipefail
# This script starts its own daemons.
export CPART_NO_AUTOSTART=1
cd "$(dirname "$0")/.."
ROOT=$PWD
WORK=$(mktemp -d)
PORT=${PORT:-7467}
RELAY=ws://127.0.0.1:$PORT
ALICE_PASS=alice-correct-horse
BOB_PASS=bob-battery-staple
OWNER=$(gh api user --jq .login)
NAME=counterpart-demo-$(date +%m%d%H%M)

cpart() { local who=$1 pass=$2; shift 2; CPART_HOME=$WORK/$who CPART_PASSPHRASE=$pass node "$ROOT/packages/cli/src/main.ts" "$@"; }
alice() { cpart alice "$ALICE_PASS" "$@"; }
bob() { cpart bob "$BOB_PASS" "$@"; }
field() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
wait_for() {
  local what=$1; shift
  for _ in $(seq 1 100); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.1; done
  echo "FAIL: timed out waiting for $what" >&2; exit 1
}
g() { git -C "$REPO" -c user.name="$OWNER" -c user.email="$OWNER@users.noreply.github.com" "$@"; }

node packages/cli/src/main.ts relay --port "$PORT" --db "$WORK/relay.db" >"$WORK/relay.log" 2>&1 &
pids+=("$!")
wait_for "relay" curl -sf "http://127.0.0.1:$PORT/healthz"
alice init --relay "$RELAY" >/dev/null
bob init --relay "$RELAY" >/dev/null
CPART_HOME=$WORK/alice node packages/cli/src/main.ts daemon >"$WORK/alice.log" 2>&1 &
pids+=("$!")
CPART_HOME=$WORK/bob node packages/cli/src/main.ts daemon >"$WORK/bob.log" 2>&1 &
pids+=("$!")
bob accept "$(alice invite bob --json | field .invite)" alice >/dev/null
wait_for "pairing" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contacts | grep -q active"
wait_for "pairing" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contacts | grep -q active"

step "alice's repository, pushed to a private GitHub repo"
REPO=$WORK/$NAME
mkdir -p "$REPO/src" "$REPO/fixtures/page/valid" "$REPO/fixtures/page/invalid"
cat >"$REPO/src/orders.js" <<'JS'
import { db } from "./db.js";

// GET /v2/orders
export function listOrders(query) {
  const limit = Math.min(Number(query.limit ?? 50), 100);
  const offset = Number(query.offset ?? 0);
  const rows = db.orders({ offset, limit });
  return { data: rows, total: db.countOrders() };
}
JS
cat >"$REPO/src/db.js" <<'JS'
const ORDERS = Array.from({ length: 500 }, (_, i) => ({ id: `o_${String(500 - i).padStart(4, "0")}`, created_at: 1700000000 - i }));

export const db = {
  orders: ({ offset, limit }) => ORDERS.slice(offset, offset + limit),
  countOrders: () => ORDERS.length,
  // Rows strictly after the row with this id, newest first. `after` may be null.
  ordersAfter: (after, limit) => {
    const start = after ? ORDERS.findIndex((o) => o.id === after) + 1 : 0;
    return ORDERS.slice(start, start + limit);
  },
};
JS
cat >"$REPO/src/orders.test.js" <<'JS'
import { test } from "node:test";
import assert from "node:assert/strict";
import { listOrders } from "./orders.js";

test("returns at most the requested number of orders", () => {
  assert.equal(listOrders({ limit: 10 }).data.length, 10);
});
JS
echo '{"data":[{"id":"o_0500"}],"next_cursor":"b18wNTAw"}' >"$REPO/fixtures/page/valid/first-page.json"
echo '{"data":[],"next_cursor":null}' >"$REPO/fixtures/page/valid/last-page.json"
echo '{"data":[{"id":"o_0500"}],"total":500}' >"$REPO/fixtures/page/invalid/old-offset-shape.json"
echo '{"data":[{"id":"o_0500"}],"next_cursor":7}' >"$REPO/fixtures/page/invalid/numeric-cursor.json"
echo '{"name":"shop-api","type":"module","private":true,"scripts":{"test":"node --test"}}' >"$REPO/package.json"
printf '# shop-api\n\nA demo repository for Counterpart.\n' >"$REPO/README.md"
git -C "$REPO" init -q -b main
g add -A
g commit -q -m "chore: initial backend with offset pagination"
gh repo create "$OWNER/$NAME" --private --source "$REPO" --push --description "Counterpart demo: a pull request that carries a signed agreement" >/dev/null
echo "https://github.com/$OWNER/$NAME"

step "the two sign a contract with a schema attached"
THREAD=$(alice open bob "agree on orders pagination" --json | field .threadId)
cat >"$WORK/contract.md" <<'DOC'
GET /v2/orders returns orders newest first.
It paginates with an opaque `cursor` query parameter. The response has `data` and `next_cursor`.
`next_cursor` is null on the last page. There is no `total` and no `offset`.
`limit` is 1 to 200, default 50.
The response follows the attached schema, page.schema.json.
DOC
cat >"$WORK/page.schema.json" <<'JSON'
{
  "type": "object",
  "required": ["data", "next_cursor"],
  "properties": {
    "data": { "type": "array", "maxItems": 200, "items": { "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } } },
    "next_cursor": { "type": ["string", "null"] }
  },
  "additionalProperties": false
}
JSON
P=$(bob propose "$THREAD" --title "Orders pagination" --file "$WORK/contract.md" --part "json-schema:$WORK/page.schema.json" --json | field .proposalId)
wait_for "alice to see it" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contracts $THREAD | grep -q open"
alice approve "$THREAD" "${P:0:10}" --yes >/dev/null 2>&1
bob approve "$THREAD" "${P:0:10}" --yes >/dev/null 2>&1
wait_for "agreement" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contracts $THREAD | grep -q agreed"
alice contracts "$THREAD"

step "alice ties her main branch to the agreement"
alice repo init "$THREAD" "${P:0:10}" --repo "$REPO" --bind "page.schema.json=schemas/page.schema.json,fixtures/page/valid,fixtures/page/invalid"
g add -A
g commit -q -m "chore: trust the orders pagination agreement and add the verifier"
g push -q origin main

step "her worker proposes the change (real model, no tools); she reads it and applies it"
ID=$(alice work "$THREAD" "${P:0:10}" --repo "$REPO" --paths src/orders.js,src/orders.test.js,src/db.js --brief "Implement the agreed pagination in listOrders using db.ordersAfter, and update the tests." --json | field .id)
alice work show "$ID" | sed -n '1,12p'
HASH=$(alice work show "$ID" --json | field .workHash)
alice work apply "$ID" "${HASH:0:12}"

step "she publishes"
URL=$(alice pr "$THREAD" "${P:0:10}" --work "$ID" --yes --json | field .url)
echo "$URL"
PR=${URL##*/}

verify_on_github() {
  local sha=$1 want=$2
  gh workflow run counterpart-verify.yml -R "$OWNER/$NAME" -f pr="$PR" >/dev/null
  for _ in $(seq 1 90); do
    state=$(gh api "repos/$OWNER/$NAME/commits/$sha/statuses" --jq '[.[] | select(.context == "counterpart/verify")][0] | "\(.state): \(.description)"' 2>/dev/null || true)
    if [ -n "$state" ] && [ "$state" != "null: null" ]; then echo "counterpart/verify on ${sha:0:7} -> $state"; case "$state" in "$want"*) return 0 ;; *) echo "FAIL: wanted $want" >&2; exit 1 ;; esac; fi
    sleep 4
  done
  echo "FAIL: no status after six minutes" >&2; exit 1
}

step "the workflow on main checks the pull request"
sleep 5
verify_on_github "$(g rev-parse HEAD)" success

step "one byte of the schema changes, and the check fails"
sed -i 's/"maxItems": 200/"maxItems": 201/' "$REPO/schemas/page.schema.json"
g commit -q -am "fix: allow one more item"
g push -q origin HEAD
sleep 5
verify_on_github "$(g rev-parse HEAD)" failure

printf '\nThe repository is left in place: https://github.com/%s/%s (private)\nPUBLISH DEMO OK\n' "$OWNER" "$NAME"
