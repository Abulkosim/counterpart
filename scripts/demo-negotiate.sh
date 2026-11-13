#!/usr/bin/env bash
# Two agents negotiate a contract; two humans approve it. Alice's and Bob's
# Claude Code sessions have only the Counterpart MCP tools. They take turns,
# each turn a fresh session told the thread id. Then this script plays both
# humans: it prints the latest open proposal, approves it on each side with
# `cpart approve`, exports the agreement twice and verifies it.
# Uses real models, so it costs tokens, takes minutes and is not run in CI.
# What the agents do differs from run to run. Read the output.
#
# If the two briefs leave no room, the agents should stall and say so, and the
# script fails with "no open proposal". That is a correct ending.
#
#   ./scripts/demo-negotiate.sh
#   KEEP=1 ./scripts/demo-negotiate.sh    # keep the work directory and the session transcripts
#   ALICE_BRIEF="..." BOB_BRIEF="..." ./scripts/demo-negotiate.sh
set -euo pipefail
# This script starts its own daemons.
export CPART_NO_AUTOSTART=1
cd "$(dirname "$0")/.."
ROOT=$PWD
WORK=$(mktemp -d)
PORT=${PORT:-7466}
RELAY=ws://127.0.0.1:$PORT
ROUNDS=${ROUNDS:-3}
ALICE_PASS=alice-correct-horse
BOB_PASS=bob-battery-staple

ALICE_BRIEF=${ALICE_BRIEF:-"I am Alice. I own the orders backend. Bob's team owns the client that calls GET /v2/orders. I want a contract with them on pagination: cursor pagination, a maximum page size of 100, and the client stops using offset pagination by 2027-01-15, because that is when I switch offsets off. Bigger pages cost me database time, so I want the limit as low as the client can live with. If they have a real need for more I can go as high as 250, not beyond. The date is fixed."}
BOB_BRIEF=${BOB_BRIEF:-"I am Bob. I own the client app that calls Alice's GET /v2/orders. We are settling how it paginates. Our tablet layout shows 200 rows at once, so I need a maximum page size of at least 200. I also want a JSON Schema for the page response attached to whatever we agree, so my team can generate types from it."}
TURN="Read the thread and its proposals. Then make the one move that gets us closer to a contract I could approve: counter-propose, or decline with a reason, or, if the latest open proposal already gives me what I need, leave it as it is. Finish with a short report to me: what is on the table, what you did, and what I should look at before I decide."

# The passphrase is given to `cpart init` and `cpart approve` only. Daemons and
# the agents' MCP servers never have it in their environment.
cpart() { local who=$1; shift; CPART_HOME=$WORK/$who node "$ROOT/packages/cli/src/main.ts" "$@"; }
human() { local who=$1 pass=$2; shift 2; CPART_HOME=$WORK/$who CPART_PASSPHRASE=$pass node "$ROOT/packages/cli/src/main.ts" "$@"; }
pids=()
cleanup() {
  kill "${pids[@]}" 2>/dev/null || true
  wait 2>/dev/null || true
  if [ -n "${KEEP:-}" ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT
# Thread and proposal ids can start with a dash, so they go after "--".
field() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
wait_for() {
  local what=$1; shift
  for _ in $(seq 1 100); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.1; done
  fail "timed out waiting for $what"
}

node packages/cli/src/main.ts relay --port "$PORT" --db "$WORK/relay.db" >"$WORK/relay.log" 2>&1 &
pids+=("$!")
wait_for "relay" curl -sf "http://127.0.0.1:$PORT/healthz"
human alice "$ALICE_PASS" init --relay "$RELAY" >/dev/null
human bob "$BOB_PASS" init --relay "$RELAY" >/dev/null
for who in alice bob; do
  CPART_HOME=$WORK/$who node packages/cli/src/main.ts daemon >"$WORK/$who.log" 2>&1 &
  pids+=("$!")
  cat >"$WORK/$who.mcp.json" <<JSON
{ "mcpServers": { "counterpart": { "command": "node", "args": ["$ROOT/packages/cli/src/main.ts", "mcp"], "env": { "CPART_HOME": "$WORK/$who", "CPART_NO_AUTOSTART": "1" } } } }
JSON
done
cpart bob accept "$(cpart alice invite bob --json | field .invite)" alice >/dev/null
wait_for "pairing" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contacts | grep -q active"
wait_for "pairing" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contacts | grep -q active"
mkdir "$WORK/session" "$WORK/runs"

# One turn: a fresh Claude Code session with the Counterpart tools and nothing
# else. Prints each tool call, each error and what the agent says.
turn() {
  local who=$1 n=$2 prompt=$3
  step "$who's agent, turn $n"
  (cd "$WORK/session" && timeout 600 claude -p "$prompt" --mcp-config "$WORK/$who.mcp.json" --strict-mcp-config --tools "" --allowedTools "mcp__counterpart__*" \
    --setting-sources "" --no-session-persistence --model "${MODEL:-claude-sonnet-5-5}" --output-format stream-json --verbose </dev/null) >"$WORK/runs/$who-$n.jsonl" || echo "(the session ended with an error)"
  node -e '
    const cut = (s, n) => (s.length > n ? s.slice(0, n) + " ...[" + s.length + " chars]" : s);
    for (const line of require("fs").readFileSync(process.argv[1], "utf8").split("\n")) {
      let m; try { m = JSON.parse(line); } catch { continue; }
      for (const c of (m.message && Array.isArray(m.message.content) ? m.message.content : [])) {
        if (m.type === "assistant" && c.type === "tool_use") console.log("  call " + c.name.replace("mcp__counterpart__", "") + " " + cut(JSON.stringify(c.input), 400));
        if (m.type === "assistant" && c.type === "text" && c.text.trim()) console.log(c.text.trim());
        if (m.type === "user" && c.type === "tool_result" && c.is_error) console.log("  tool error: " + cut(typeof c.content === "string" ? c.content : JSON.stringify(c.content), 300));
      }
    }' "$WORK/runs/$who-$n.jsonl"
}
# Ids and states of every proposal, to tell whether a turn changed anything.
state() { cpart "$1" contracts --json -- "$THREAD" | node -pe "JSON.parse(require('fs').readFileSync(0)).map((c) => c.proposalId + ':' + c.status + ':' + c.declinedBy.length).join(' ')"; }
latest_open() { cpart "$1" contracts --json -- "$THREAD" | node -pe "(JSON.parse(require('fs').readFileSync(0)).filter((c) => c.status === 'open').at(-1) || {})[process.argv[1]] ?? ''" "$2"; }
settle() { sleep 2; wait_for "both sides to hold the same proposals" sh -c "[ \"\$(CPART_HOME=$WORK/alice node packages/cli/src/main.ts contracts --json -- $THREAD | wc -c)\" -gt 2 ] && [ \"\$(CPART_HOME=$WORK/alice node packages/cli/src/main.ts contracts --json -- $THREAD | grep -c proposalId)\" = \"\$(CPART_HOME=$WORK/bob node packages/cli/src/main.ts contracts --json -- $THREAD | grep -c proposalId)\" ]"; }

turn alice 1 "$ALICE_BRIEF

Open a thread with bob and propose a contract. You are only starting this off: after proposing, do not wait for an answer. Finish with a short report to me."
THREAD=$(cpart alice threads --json | field '[0].id')
[ -n "$THREAD" ] && [ "$THREAD" != undefined ] || fail "alice's agent opened no thread"
settle

settled=""
for n in $(seq 1 "$ROUNDS"); do
  for who in bob alice; do
    if [ "$who" = alice ] && [ "$n" = "$ROUNDS" ]; then continue; fi
    other=$([ "$who" = alice ] && echo bob || echo alice)
    k=$([ "$who" = alice ] && echo $((n + 1)) || echo "$n")
    before=$(state "$who")
    turn "$who" "$k" "$([ "$who" = alice ] && echo "$ALICE_BRIEF" || echo "$BOB_BRIEF")

My agent and $other's agent are part way through this in Counterpart thread $THREAD. You are picking it up with no memory of earlier turns. $TURN"
    settle
    # A side that reads the other side's open proposal and changes nothing has nothing left to ask for.
    if [ "$(state "$who")" = "$before" ] && [ "$(latest_open "$who" proposedByMe)" = false ]; then settled=$who; break 2; fi
  done
done
if [ -n "$settled" ]; then step "the agents have stopped: the agent of $settled left the open proposal as it is"; else step "the agents have stopped: out of turns"; fi

step "proposals, as alice's machine holds them"
cpart alice contracts -- "$THREAD"
ID=$(latest_open alice proposalId)
if [ -z "$ID" ]; then
  step "the thread, as alice sees it"
  cpart alice log -- "$THREAD"
  step "the thread, as bob sees it"
  cpart bob log -- "$THREAD"
  fail "no open proposal: the agents did not leave anything to approve"
fi
[ -n "$settled" ] || echo "NOTE: no agent left the other side's proposal standing within $ROUNDS turns each. The humans read the latest open one anyway."

step "what alice reads before she signs: the latest open proposal, in full"
cpart alice contract -- "$THREAD" "$ID"
cpart alice contract --json -- "$THREAD" "$ID" >"$WORK/final.json"
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).contract;
  const all = c.text + "\n" + c.parts.map((p) => p.content).join("\n");
  const size = /\b(1\d\d|[2-9]\d\d|\d{2})\b/.test(all) && /page size|limit|maxItems/i.test(all);
  const schema = c.parts.filter((p) => p.kind === "json-schema").map((p) => p.name);
  console.log("\ncheck: names a page size: " + (size ? "yes" : "NO"));
  console.log("check: json-schema attachments: " + (schema.length ? schema.join(", ") : "NONE"));
  console.log("check: mentions offsets: " + (/offset/i.test(all) ? "yes" : "NO"));' "$WORK/final.json"

step "the humans approve, each in their own terminal with their own passphrase"
human alice "$ALICE_PASS" approve --yes -- "$THREAD" "$ID" 2>/dev/null
wait_for "bob to see alice's approval" sh -c "CPART_HOME=$WORK/bob node packages/cli/src/main.ts contracts --json -- $THREAD | grep -q '\"approvedByThem\": *true'"
human bob "$BOB_PASS" approve --yes -- "$THREAD" "$ID" 2>/dev/null
wait_for "alice to see the agreement" sh -c "CPART_HOME=$WORK/alice node packages/cli/src/main.ts contracts -- $THREAD | grep -q agreed"
cpart alice contracts -- "$THREAD"

step "both export; the files are identical and verify with no database"
cpart alice agreement export --out "$WORK/alice-agreement.json" -- "$THREAD" "$ID"
cpart bob agreement export --out "$WORK/bob-agreement.json" -- "$THREAD" "$ID"
cmp "$WORK/alice-agreement.json" "$WORK/bob-agreement.json" || fail "the two exports differ"
echo "the two files are identical"
CPART_HOME=$WORK/nobody node packages/cli/src/main.ts agreement verify "$WORK/alice-agreement.json"

step "the thread, as alice sees it"
cpart alice log -- "$THREAD"
step "the thread, as bob sees it"
cpart bob log -- "$THREAD"

step "did an agent claim or attempt an approval?"
if grep -l '"name":"mcp__counterpart__[a-z_]*\(approve\|accept\)' "$WORK"/runs/*.jsonl; then echo "an agent called an approve tool (see above)"; else echo "tool calls naming approve or accept: none"; fi
echo "approvals in the log were made by this script with cpart approve, after the last agent turn."
printf '\nNEGOTIATION DEMO DONE\n'
