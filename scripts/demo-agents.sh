#!/usr/bin/env bash
# Bob's Claude Code session asks Alice's front desk a question through the
# Counterpart MCP tools while Alice is away.
#
#   ./scripts/demo-agents.sh ["question for bob's agent to get answered"]
#
# Needs: node 24, claude logged in.
# Cost:  model tokens: one claude session and the front desk's replies. Not run in CI.
set -euo pipefail
# This script starts its own daemons.
export CPART_NO_AUTOSTART=1
cd "$(dirname "$0")/.."
ROOT=$PWD
WORK=$(mktemp -d)
PORT=${PORT:-7464}
RELAY=ws://127.0.0.1:$PORT
QUESTION=${1:-"Find out from alice's agent how GET /v2/orders paginates, what the maximum page size is, and whether creating an order needs an idempotency key. Then give me a three-line summary."}

cpart() { local who=$1; shift; CPART_HOME=$WORK/$who node "$ROOT/packages/cli/src/main.ts" "$@"; }
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
field() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }

node packages/cli/src/main.ts relay --port "$PORT" --db "$WORK/relay.db" >"$WORK/relay.log" 2>&1 &
pids+=("$!")
sleep 1
cpart alice init --relay "$RELAY" --no-passphrase >/dev/null
cpart bob init --relay "$RELAY" --no-passphrase >/dev/null
CPART_HOME=$WORK/alice node packages/cli/src/main.ts daemon >"$WORK/alice.log" 2>&1 &
pids+=("$!")
CPART_HOME=$WORK/bob node packages/cli/src/main.ts daemon >"$WORK/bob.log" 2>&1 &
pids+=("$!")
sleep 1
cpart bob accept "$(cpart alice invite bob --json | field .invite)" alice >/dev/null
sleep 1

mkdir "$WORK/docs"
cat >"$WORK/docs/orders-api.md" <<'DOC'
# Orders API (v2)

GET /v2/orders lists orders, newest first.
- Pagination: cursor based. Pass `cursor` from the previous response's `next_cursor`. Cursors are opaque strings and expire after 24 hours.
- `limit`: 1-100, default 50.
- Filter by `status`: pending, paid, shipped, cancelled.

POST /v2/orders creates an order. Requires an `Idempotency-Key` header (any UUID). Replays within 24 hours return the original response.
DOC
cpart alice bundle add bob "$WORK/docs/orders-api.md" >/dev/null
cpart alice desk on bob --as Alice >/dev/null

cat >"$WORK/mcp.json" <<JSON
{ "mcpServers": { "counterpart": { "command": "node", "args": ["$ROOT/packages/cli/src/main.ts", "mcp"], "env": { "CPART_HOME": "$WORK/bob", "CPART_NO_AUTOSTART": "1" } } } }
JSON

echo "== Bob asks his agent:"
echo "$QUESTION"
echo
echo "== Bob's agent (Claude Code, Counterpart tools only):"
mkdir "$WORK/session"
(cd "$WORK/session" && claude -p "$QUESTION" --mcp-config "$WORK/mcp.json" --strict-mcp-config --tools "" --allowedTools "mcp__counterpart__*" --setting-sources "" --no-session-persistence --model "${MODEL:-claude-sonnet-5-5}")
echo
echo "== The thread, as Alice will find it when she is back:"
THREAD=$(cpart alice threads --json | field '[0].id')
cpart alice log "$THREAD"
echo
echo "== Questions the front desk passed to Alice:"
cpart alice asks
