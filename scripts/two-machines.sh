#!/usr/bin/env bash
# Two people on two machines, over the public internet.
#   Alice and the relay run on this machine. The relay gets a public wss://
#   address from a cloudflared quick tunnel.
#   Bob runs in a container with its own disk. It is given the invite and
#   nothing else, and reaches the relay only through the public address.
# They pair, talk, and sign an agreement. Needs docker and cloudflared.
set -euo pipefail
cd "$(dirname "$0")/.."
export CPART_NO_BOOT=1
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cpart-two.XXXXXX")
PORT=${PORT:-7463}
BOB=cpart-bob-$$
alice() { CPART_HOME="$WORK/alice" CPART_PASSPHRASE="alice long passphrase" node packages/cli/src/main.ts "$@"; }
bob() { docker exec -e CPART_PASSPHRASE="bob long passphrase" "$BOB" node packages/cli/src/main.ts "$@"; }
step() { printf '\n== %s\n' "$*"; }
cleanup() {
  code=$?
  trap - EXIT
  alice down >/dev/null 2>&1 || true
  docker rm -f "$BOB" >/dev/null 2>&1 || true
  [ -n "${RELAY_PID:-}" ] && kill "$RELAY_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  if [ "$code" -ne 0 ]; then echo "FAILED. Logs kept in $WORK" >&2; else rm -rf "$WORK"; fi
  exit "$code"
}
trap cleanup EXIT
wait_for() {
  local what=$1; shift
  for _ in $(seq 1 150); do if "$@" >"$WORK/wait.out" 2>&1; then return 0; fi; sleep 0.4; done
  echo "FAIL: timed out waiting for $what" >&2; cat "$WORK/wait.out" >&2; exit 1
}

step "build the image Bob's machine runs"
docker build -q -t counterpart:two . >/dev/null

step "a relay on this machine, with a public address"
node packages/cli/src/main.ts relay --port "$PORT" --db "$WORK/relay.db" --tunnel >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!
wait_for "the tunnel" grep -q "relay listening on wss://" "$WORK/relay.log"
RELAY=$(grep -o 'wss://[a-z0-9.-]*trycloudflare.com' "$WORK/relay.log" | head -1)
echo "$RELAY"
wait_for "the public address to answer" curl -sf "https://${RELAY#wss://}/healthz"

step "Alice, here: cpart setup"
alice setup --relay "$RELAY" --no-agents

step "Bob, in a container that knows nothing yet"
docker run -d --name "$BOB" --entrypoint sleep counterpart:two infinity >/dev/null
wait_for "Bob's machine to resolve the relay's name" docker exec "$BOB" node -e "fetch('https://${RELAY#wss://}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
INVITE=$(alice invite bob --long | grep -o 'cpart-invite:[A-Za-z0-9_-]*')
bob join "$INVITE" alice --no-agents

step "the safety codes match"
A=$(alice contacts --json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].safetyCode')
B=$(bob contacts --json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].safetyCode')
echo "alice sees $A, bob sees $B"
[ "$A" = "$B" ]

step "they talk"
bob open alice "agree on the page size" >/dev/null
bob say alice "Bob here, from another machine. Is 50 per page fine?" >/dev/null
wait_for "Alice to get Bob's message" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts log bob | grep -q 'another machine'"
alice say bob "Fine with me. I will write it down." >/dev/null
wait_for "Bob to get the reply" docker exec "$BOB" sh -c "node packages/cli/src/main.ts log alice | grep -q 'write it down'"
bob log alice

step "they sign the same text"
printf 'Orders are returned 50 per page.\n' >"$WORK/contract.md"
ID=$(alice propose bob --title "Page size" --file "$WORK/contract.md" --json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).proposalId')
alice approve bob "$ID" --yes >/dev/null 2>&1
wait_for "Bob to see the proposal" docker exec "$BOB" sh -c "node packages/cli/src/main.ts contracts alice | grep -q 'Page size'"
bob approve alice "$ID" --yes >/dev/null 2>&1
wait_for "Alice to see both signatures" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts contracts bob | grep -q agreed"
alice contracts bob
alice agreement export bob "$ID" --out "$WORK/agreement.json" >/dev/null
bob agreement export alice "$ID" --out /tmp/agreement.json >/dev/null
docker cp -q "$BOB:/tmp/agreement.json" "$WORK/agreement.bob.json"
node packages/cli/src/main.ts agreement verify "$WORK/agreement.bob.json" | head -3
[ -n "$(grep -o 'Valid' <(node packages/cli/src/main.ts agreement verify "$WORK/agreement.json"))" ]

step "what the relay saw"
echo "relay database: $(du -h "$WORK/relay.db" | cut -f1). Searching it for the words they exchanged:"
if grep -a -c -e "another machine" -e "50 per page" "$WORK/relay.db" "$WORK/relay.db-wal" 2>/dev/null | grep -v ':0$'; then echo "FAIL: plaintext on the relay" >&2; exit 1; fi
echo "none found"

echo
echo "TWO MACHINES OK"
