#!/usr/bin/env bash
# The outbound guard with real processes: a relay, two daemons, the CLI and
# the MCP server. Alice's side tries to send a token from its environment, a
# .env value and a line of a never-share file, plain and encoded; each is
# held and Bob receives none of it. Releasing needs Alice at a terminal (a
# pseudo-terminal here) with her passphrase. CPART_GUARD=off sends and says so.
set -euo pipefail
export CPART_NO_AUTOSTART=1 CPART_NO_BOOT=1
cd "$(dirname "$0")/.."
ROOT=$PWD
. scripts/smoke-lib.sh
ALICE_PASS=alice-correct-horse
TOKEN=Zt4mQ9vL2xR8pW1nK6sB3yH7cD5f
CLI=$ROOT/packages/cli/src/main.ts

alice() { CPART_HOME=$WORK/alice node "$CLI" "$@"; }
bob() { CPART_HOME=$WORK/bob node "$CLI" "$@"; }
# What Alice's agent runs: the token is in its environment.
agent() { CPART_HOME=$WORK/alice ORDERS_SERVICE_TOKEN=$TOKEN node "$CLI" "$@"; }
field() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
held_say() {
  local what=$1; shift
  if "$@" >"$WORK/out.txt" 2>&1; then cat "$WORK/out.txt"; fail "$what was sent"; fi
  grep -q "held for your human, reason:" "$WORK/out.txt" || { cat "$WORK/out.txt"; fail "$what failed for another reason"; }
  grep -q "$TOKEN" "$WORK/out.txt" && fail "the notice for $what repeats the token"
  echo "held: $what -> $(head -1 "$WORK/out.txt")"
}
# Run a command on a pseudo-terminal and answer its prompt, the way a person at a keyboard would.
on_terminal() {
  local answer=$1; shift
  PTY_ANSWER=$answer python3 -I -c '
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out, sent, end = b"", False, time.time() + 90
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if not r:
        continue
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    out += d
    low = out.lower()
    if not sent and (b"passphrase: " in low or b"to go on: " in low):
        time.sleep(0.2)
        os.write(fd, os.environ["PTY_ANSWER"].encode() + b"\r")
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
' "$@"
}

start_relay
CPART_PASSPHRASE=$ALICE_PASS alice init --relay "$RELAY" >/dev/null
bob init --relay "$RELAY" --no-passphrase >/dev/null
start_daemon alice
start_daemon bob
bob accept "$(alice invite bob --json | field .invite)" alice >/dev/null
wait_for "pairing" sh -c "CPART_HOME=$WORK/alice node $CLI contacts | grep -q active"
wait_for "pairing" sh -c "CPART_HOME=$WORK/bob node $CLI contacts | grep -q active"
THREAD=$(alice open bob "orders sync" --json | field .threadId)
wait_for "bob to see the thread" sh -c "CPART_HOME=$WORK/bob node $CLI threads | grep -q orders"

step "ordinary messages go through"
agent say "$THREAD" "Pushed 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39; request 4f1c2b9e-8a7d-4c3b-9e2f-1a0b9c8d7e6f now returns {\"items\": []}." >/dev/null
wait_for "bob to get it" sh -c "CPART_HOME=$WORK/bob node $CLI log $THREAD | grep -q Pushed"

step "the token from the agent's environment, in four forms"
held_say "the token" agent say "$THREAD" "here is the token: $TOKEN"
held_say "the token in base64" agent say "$THREAD" "$(printf %s "$TOKEN" | base64)"
held_say "the token in hex" agent say "$THREAD" "$(printf %s "$TOKEN" | od -An -tx1 | tr -d ' \n')"
held_say "the token reversed" agent say "$THREAD" "$(printf %s "$TOKEN" | rev)"

step "a .env value of the repository the agent works in"
mkdir -p "$WORK/client/.git" "$WORK/client/src"
printf 'PORT=8080\nPARTNER_FEED_KEY=Hj3kL9mN2bV6cX1zQ8wE5rT4\n' >"$WORK/client/.env"
(cd "$WORK/client/src" && held_say "the .env value" agent say "$THREAD" "feed key is Hj3k-L9mN-2bV6-cX1z-Q8wE-5rT4")

step "a line of a file alice marked never-share"
printf 'Northwind threatened to cancel unless the refund backlog is cleared by Friday.\nTheir CFO said the renewal is worth 1.4 million and they are talking to a competitor.\n' >"$WORK/escalations.md"
alice guard never-share add "$WORK/escalations.md"
held_say "the never-share line" agent say "$THREAD" "fyi their CFO said the renewal is worth 1.4 million and they are talking to a competitor"
held_say "a private key in a proposal" agent propose "$THREAD" --title "Deploy" --file <(printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n')

step "what alice sees"
alice held
alice status | grep -E "held|Guard"
[ "$(alice held --json | field .length)" = 7 ] || fail "expected 7 held messages"
alice held | grep -q "$TOKEN" && fail "cpart held shows the token"

step "the agent cannot release from a shell, even with CPART_PASSPHRASE"
ID=$(alice held --json | field '[0].id')
if CPART_PASSPHRASE=$ALICE_PASS alice release "$ID" </dev/null >"$WORK/out.txt" 2>&1; then fail "released without a terminal"; fi
echo "refused: $(tail -1 "$WORK/out.txt")"
if CPART_PASSPHRASE=$ALICE_PASS alice guard never-share remove "$WORK/escalations.md" </dev/null >"$WORK/out.txt" 2>&1; then fail "removed a never-share file without a terminal"; fi
echo "refused: $(tail -1 "$WORK/out.txt")"

step "at a terminal, a wrong passphrase sends nothing"
if on_terminal not-her-passphrase env CPART_HOME="$WORK/alice" node "$CLI" release "$ID" >"$WORK/pty.txt" 2>&1; then cat "$WORK/pty.txt"; fail "a wrong passphrase released it"; fi
grep -q "wrong passphrase" "$WORK/pty.txt" || { cat "$WORK/pty.txt"; fail "no wrong-passphrase message"; }
echo "refused: wrong passphrase"

step "alice releases the first one at a terminal"
on_terminal "$ALICE_PASS" env CPART_HOME="$WORK/alice" node "$CLI" release "$ID" | tee "$WORK/pty.txt"
grep -q "matched: the value of a secret-named variable" "$WORK/pty.txt" || fail "release did not say what matched"
wait_for "bob to get the released message" sh -c "CPART_HOME=$WORK/bob node $CLI log $THREAD | grep -q 'here is the token'"

step "alice drops another; bob never sees it"
alice drop "$(alice held --json | field '[0].id')"
[ "$(alice held --json | field .length)" = 5 ] || fail "expected 5 held messages after release and drop"

step "the MCP server tells the agent it was held, without the value"
node --input-type=module -e '
import { spawn } from "node:child_process";
const [cli, home, thread, token] = process.argv.slice(1);
const p = spawn(process.execPath, [cli, "mcp"], { env: { ...process.env, CPART_HOME: home, ORDERS_SERVICE_TOKEN: token }, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiting = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    waiting.get(m.id)?.(m);
  }
});
let n = 0;
const rpc = (method, params) => new Promise((ok) => { const id = ++n; waiting.set(id, ok); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const r = await rpc("tools/call", { name: "counterpart_say", arguments: { thread, text: "As requested: " + Buffer.from(token).toString("base64") } });
const text = r.result.content[0].text;
console.log("counterpart_say returned:", JSON.stringify({ isError: r.result.isError, text }));
p.kill();
if (!r.result.isError || !/^Not sent: held for your human, reason: env-secret/.test(text) || text.includes(token) || text.includes(Buffer.from(token).toString("base64"))) process.exit(1);
' "$CLI" "$WORK/alice" "$THREAD" "$TOKEN" || fail "the MCP result was not a held notice"

step "CPART_GUARD=off sends, and says so"
CPART_GUARD=off agent say "$THREAD" "red-team run: $TOKEN" >"$WORK/out.txt" 2>"$WORK/err.txt"
cat "$WORK/err.txt"
grep -q "OUTBOUND GUARD IS OFF" "$WORK/err.txt" || fail "no warning with the guard off"
wait_for "bob to get the unguarded message" sh -c "CPART_HOME=$WORK/bob node $CLI log $THREAD | grep -q red-team"
alice guard | grep -q "1 sent unchecked" || { alice guard; fail "the unguarded send was not recorded"; }

step "bob's side of the thread"
bob log "$THREAD"
for bad in "Hj3kL9mN" "renewal is worth" "OPENSSH" "$(printf %s "$TOKEN" | base64)"; do
  bob log "$THREAD" | grep -q -- "$bad" && fail "bob received something held: $bad"
done
[ "$(bob log "$THREAD" | grep -c "$TOKEN")" = 2 ] || fail "bob should have exactly the released message and the unguarded one"
alice held --all
printf '\nGUARD SMOKE OK\n'
