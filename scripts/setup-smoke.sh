#!/usr/bin/env bash
# The short path, as two new people would take it: `cpart setup` on one side,
# `cpart join` on the other, background daemons, then a message addressed by
# contact name. Stand-ins for `claude` and `codex` record what setup asked of
# them; nothing is written to your real agent settings.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/smoke-lib.sh
unset CPART_NO_AUTOSTART
export CPART_NO_BOOT=1 CPART_PASSPHRASE="correct horse battery"
# Setup also writes Codex's hooks.json itself, not through the stand-in.
export CODEX_HOME=$WORK/codex CLAUDE_CONFIG_DIR=$WORK/claude

mkdir -p "$WORK/bin"
for agent in claude codex; do
  cat >"$WORK/bin/$agent" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "--version ") echo fake ;;
  "mcp get") cat "$WORK/$agent.added" 2>/dev/null ;;
  "mcp add") echo "\$*" >"$WORK/$agent.added" ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$WORK/bin/$agent"
done
export PATH="$WORK/bin:$PATH"
cpart() { local who=$1; shift; CPART_HOME="$WORK/$who" node packages/cli/src/main.ts "$@"; }
stop_all() { for w in alice bob dave erin shared frank henry; do cpart "$w" down >/dev/null 2>&1 || true; done; }
trap 'stop_all; cleanup' EXIT

step "a relay"
start_relay

step "nothing is created when no relay answers"
if cpart alice setup --relay ws://127.0.0.1:1 >"$WORK/dead.out" 2>&1; then fail "setup accepted a dead relay"; fi
grep -q "no relay answers" "$WORK/dead.out"
[ ! -e "$WORK/alice/keys.json" ] || fail "an identity was created for a dead relay"

step "alice: cpart setup"
cpart alice setup --relay "$RELAY" | tee "$WORK/alice.setup"
grep -q "^ok  identity .* created" "$WORK/alice.setup"
grep -q "^ok  daemon started, connected" "$WORK/alice.setup"
grep -q "^ok  Claude Code now has" "$WORK/alice.setup"
grep -q "^ok  Codex now has" "$WORK/alice.setup"
grep -q "mcp add --scope user counterpart --env CPART_HOME=$WORK/alice -- .* mcp$" "$WORK/claude.added" || fail "claude was not given the server: $(cat "$WORK/claude.added")"

step "running it again changes nothing"
cpart alice setup | tee "$WORK/alice.again"
grep -q "^ok  daemon running, connected" "$WORK/alice.again"
grep -q "^ok  Claude Code already has" "$WORK/alice.again"

step "an address with anything after the host is refused"
if cpart carol setup --relay "$RELAY/x#y" >"$WORK/frag.out" 2>&1; then fail "setup took an address with a fragment"; fi
grep -q "nothing after it but a path" "$WORK/frag.out"
[ ! -e "$WORK/carol/keys.json" ] || fail "an identity was created for a bad address"

step "a relay that does not know itself by the address: setup and join say so and keep nothing"
PORT2=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
WRONG=ws://127.0.0.1:$PORT2
RELAY2_PID=
# relay2 <the one address it answers to>: (re)starts a second relay on PORT2, same database.
relay2() {
  local before
  if [ -n "$RELAY2_PID" ]; then kill "$RELAY2_PID"; wait "$RELAY2_PID" 2>/dev/null || true; fi
  before=$(count "relay listening" "$WORK/relay2.log")
  node packages/cli/src/main.ts relay --port "$PORT2" --db "$WORK/relay2.db" --url "$1" >>"$WORK/relay2.log" 2>&1 &
  RELAY2_PID=$!
  pids+=("$RELAY2_PID")
  wait_for "the second relay" sh -c "[ \$(grep -c 'relay listening' '$WORK/relay2.log') -gt ${before:-0} ]"
}
relay2 "ws://relay.invalid:$PORT2"
if cpart dave setup --relay "$WRONG" >"$WORK/wrong.out" 2>&1; then fail "setup finished although the relay refused the login"; fi
cat "$WORK/wrong.out"
grep -q "refused to log you in (wrong_relay_url)" "$WORK/wrong.out"
grep -q -- "--url $WRONG" "$WORK/wrong.out"
grep -q "Nothing was kept" "$WORK/wrong.out"
[ ! -e "$WORK/dave" ] || fail "a refused identity was left behind: $(ls "$WORK/dave")"
if cpart erin join "7-cider-otter@$WRONG" alice --yes >"$WORK/wrong-join.out" 2>&1; then fail "join finished although the relay refused the login"; fi
grep -q "refused to log you in (wrong_relay_url)" "$WORK/wrong-join.out"
grep -q "Ask whoever runs it" "$WORK/wrong-join.out"
[ ! -e "$WORK/erin" ] || fail "join left a refused identity behind"
# A home that is a folder other programs use: only what Counterpart made goes.
mkdir -p "$WORK/shared" && echo kept >"$WORK/shared/kept-before.txt"
(sleep 4; echo notes >"$WORK/shared/notes.txt"; mkdir -p "$WORK/shared/project"; echo 'int main;' >"$WORK/shared/project/main.c") &
pids+=("$!")
if cpart shared setup --relay "$WRONG" --no-passphrase >"$WORK/shared.out" 2>&1; then fail "setup finished although the relay refused the login"; fi
grep -q "Nothing was kept" "$WORK/shared.out"
[ "$(cd "$WORK/shared" && find . -mindepth 1 | sort | tr '\n' ' ')" = "./kept-before.txt ./notes.txt ./project ./project/main.c " ] || fail "the shared home holds: $(cd "$WORK/shared" && find . -mindepth 1 | sort | tr '\n' ' ')"

step "once the relay knows the address, setup works; if it forgets, setup says so and keeps the identity"
relay2 "$WRONG"
cpart dave setup --relay "$WRONG" | tee "$WORK/dave.setup"
grep -q "^ok  daemon started, connected" "$WORK/dave.setup"
relay2 "ws://relay.invalid:$PORT2"
if cpart dave setup >"$WORK/dave.again" 2>&1; then fail "setup finished although the relay refused the login"; fi
cat "$WORK/dave.again"
grep -q "refused to log you in (wrong_relay_url)" "$WORK/dave.again"
grep -q "Your identity is unchanged" "$WORK/dave.again"
[ -e "$WORK/dave/keys.json" ] || fail "an identity that had worked was removed"
cpart dave status | tee "$WORK/dave.status"
grep -q "^  the relay at $WRONG refused to log you in (wrong_relay_url)" "$WORK/dave.status" || fail "status does not say the relay refused the login"
if grep -q "Nothing is waiting" "$WORK/dave.status"; then fail "status says nothing is waiting while the relay refuses the login"; fi
# The refusal stays in dave's database. With the relay stopped, it is old news.
cpart dave down >/dev/null
kill "$RELAY2_PID"; wait "$RELAY2_PID" 2>/dev/null || true; RELAY2_PID=
cpart dave setup | tee "$WORK/dave.down"
grep -q "^--  daemon started, but not connected" "$WORK/dave.down"
if grep -q "refused" "$WORK/dave.down"; then fail "setup took an old refusal for the relay's answer"; fi
relay2 "$WRONG"
wait_for "dave's daemon to get in by itself" sh -c "CPART_HOME='$WORK/dave' node packages/cli/src/main.ts status | grep -q '^Daemon    running, connected'"
cpart dave down >/dev/null

step "a relay whose clock is 10 minutes behind: setup says to check the clocks"
PORT3=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
node --input-type=module -e "
const { startRelay } = await import('$PWD/packages/relay/src/index.ts');
await startRelay({ port: $PORT3, host: '127.0.0.1', dbPath: '$WORK/relay3.db', now: () => Date.now() - 600000, log: console.log });
console.log('relay listening');" >"$WORK/relay3.log" 2>&1 &
pids+=("$!")
wait_for "the slow-clock relay" grep -q "relay listening" "$WORK/relay3.log"
if cpart frank setup --relay "ws://127.0.0.1:$PORT3" --no-passphrase >"$WORK/clock.out" 2>&1; then fail "setup finished although the relay refused the login"; fi
cat "$WORK/clock.out"
grep -q "refused to log you in (auth_failed)" "$WORK/clock.out"
grep -q "must agree to within 5 minutes" "$WORK/clock.out"
grep -q "Run this again once the clocks agree" "$WORK/clock.out"
if grep -q "restarted" "$WORK/clock.out"; then fail "told to restart the relay for a clock problem"; fi
[ ! -e "$WORK/frank" ] || fail "a refused identity was left behind: $(ls "$WORK/frank")"

step "three daemons started at once: one wins"
cpart alice down >/dev/null
for i in 1 2 3; do CPART_HOME="$WORK/alice" node packages/cli/src/main.ts daemon >"$WORK/race$i.log" 2>&1 & pids+=("$!"); done
wait_for "two of them to give up" sh -c "[ \$(cat '$WORK'/race?.log | grep -c 'already running') -eq 2 ]"
[ "$(cat "$WORK"/race?.log | grep -c '^connected')" -le 1 ] || fail "more than one daemon connected"
cpart alice down >/dev/null
cpart alice up >/dev/null

step "a second daemon for the same home is refused"
if cpart alice daemon >"$WORK/second.out" 2>&1; then fail "a second daemon started"; fi
grep -q "already running" "$WORK/second.out"

step "alice invites bob; bob joins with one command and no identity"
JOIN=$(cpart alice invite bob --long | grep -o 'cpart-invite:[A-Za-z0-9_-]*')
# An invite that names a relay on this machine needs a person to say yes.
if cpart bob join "$JOIN" alice </dev/null >"$WORK/bob.refused" 2>&1; then fail "join used a local relay without asking"; fi
[ ! -e "$WORK/bob/keys.json" ] || fail "an identity was created before the person agreed"
grep -q "this needs a terminal: the code or invite names a relay on your own machine or network" "$WORK/bob.refused" || fail "join did not say why it needs a terminal: $(cat "$WORK/bob.refused")"
grep -q "run the same command again with --yes" "$WORK/bob.refused" || fail "join did not name the flag that goes on"
cpart bob join "$JOIN" alice --yes | tee "$WORK/bob.join"
grep -q "Claude Code already has a server named counterpart for another identity" "$WORK/bob.join" || fail "bob was not told the agent tools belong to alice's identity"
grep -q "^ok  identity .* created" "$WORK/bob.join"
grep -q "^Paired with alice" "$WORK/bob.join"
A=$(cpart alice contacts --json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].safetyCode')
B=$(cpart bob contacts --json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].safetyCode')
[ "$A" = "$B" ] || fail "safety codes differ: $A and $B"

step "bob opens a thread and asks twice; alice has no front desk and no session that used Counterpart"
QTHREAD=$(cpart bob open alice "QMARK which page size?" --say "QMARK first question" --json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).threadId')
cpart bob say alice "QMARK second question" >/dev/null
wait_for "alice's status to show bob waiting" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts status | grep -q '^  bob wrote in thread [A-Za-z0-9_-]*: new thread, 2 messages'"
cpart alice status | tee "$WORK/alice.waiting"
sed -n '/^Waiting for you:/,/^$/p' "$WORK/alice.waiting" | grep -q "bob wrote in thread" || fail "bob's thread is not under Waiting for you"
if grep -q QMARK "$WORK/alice.waiting"; then fail "bob's words reached the status"; fi
# A Claude Code session starting on alice's machine, and another one's first prompt.
echo '{"session_id":"mac-session-1","hook_event_name":"SessionStart","source":"startup"}' | cpart alice hook start | tee "$WORK/start.json"
grep -q '"systemMessage":"Counterpart: bob wrote in 1 thread nobody on this side has read or answered. cpart status lists it."' "$WORK/start.json" || fail "a new session was not told"
grep -q '"hookEventName":"SessionStart","additionalContext":"Counterpart: bob wrote in 1 thread' "$WORK/start.json"
echo '{"session_id":"mac-session-1","hook_event_name":"UserPromptSubmit"}' | cpart alice hook prompt >"$WORK/prompt1.json"
[ ! -s "$WORK/prompt1.json" ] || fail "the session was told twice: $(cat "$WORK/prompt1.json")"
echo '{"session_id":"mac-session-2","hook_event_name":"UserPromptSubmit"}' | cpart alice hook prompt | tee "$WORK/prompt2.json"
grep -q '"hookEventName":"UserPromptSubmit","additionalContext":"Counterpart: bob wrote in 1 thread' "$WORK/prompt2.json" || fail "a second session was not told"
if grep -q QMARK "$WORK/start.json" "$WORK/prompt2.json"; then fail "bob's words reached a hook"; fi
# Bob chose the id of the thread he opened: only its start reaches a session.
grep -q "bob, thread ${QTHREAD:0:8}\.\.\.: new thread, 2 messages" "$WORK/start.json" || fail "the thread is not named by the start of its id"
if grep -q -- "$QTHREAD" "$WORK/start.json" "$WORK/prompt2.json"; then fail "the full id bob chose reached a hook"; fi
cpart bob status | tee "$WORK/bob.asked"
if grep -q "wrote in thread" "$WORK/bob.asked"; then fail "the asker is told its own question is waiting"; fi

step "bob talks to alice by name"
cpart bob open alice "agree on pagination" >/dev/null
cpart bob say alice "hello from bob" >/dev/null
wait_for "alice to receive bob's message" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts log bob | grep -q 'hello from bob'"
cpart alice say bob "hello back" >/dev/null
wait_for "bob to receive the reply" sh -c "CPART_HOME='$WORK/bob' node packages/cli/src/main.ts log alice | grep -q 'hello back'"
cpart bob log alice

step "alice invites henry with a code and waits; henry joins with --no-agents"
cpart alice invite henry >"$WORK/alice.invite" 2>&1 &
INVITE_PID=$!
pids+=("$INVITE_PID")
wait_for "alice's code" grep -q "cpart join .* <your name>" "$WORK/alice.invite"
CODE=$(grep -o "cpart join [^ ]*" "$WORK/alice.invite" | head -1 | cut -d' ' -f3)
cpart henry join "$CODE" alice --yes --no-agents --no-passphrase | tee "$WORK/henry.join"
wait "$INVITE_PID"
cat "$WORK/alice.invite"
grep -q "^Paired with henry" "$WORK/alice.invite"
grep -q "in Claude Code or Codex, say something like" "$WORK/alice.invite" || fail "alice has the agent tools but was not told to use them"
grep -q "^Paired with alice" "$WORK/henry.join"
if grep -q "in Claude Code or Codex, say" "$WORK/henry.join"; then fail "join --no-agents pointed at Claude Code or Codex"; fi
grep -q 'cpart open alice "<what it is about>"' "$WORK/henry.join" || fail "join --no-agents did not say how to talk from the terminal"
cpart henry down >/dev/null

step "status on both sides"
cpart alice status | tee "$WORK/alice.status"
grep -q "^Daemon    running, connected" "$WORK/alice.status"
grep -q "^Contacts  bob" "$WORK/alice.status"
grep -q "Claude Code: has the tools" "$WORK/alice.status"

step "cpart down"
cpart alice down
cpart alice status | grep -q "^Daemon    NOT running" || fail "status did not notice the daemon stopped"
cpart bob down

step "an agent session that finds no daemon starts one"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | timeout 20 env CPART_HOME="$WORK/alice" node packages/cli/src/main.ts mcp >"$WORK/mcp.out" || true
grep -q '"name":"counterpart"' "$WORK/mcp.out" || fail "the MCP server did not answer: $(cat "$WORK/mcp.out")"
cpart alice status | grep -q "^Daemon    running, connected" || fail "the MCP server did not start the daemon"
cpart alice down >/dev/null

echo
echo "SETUP SMOKE OK"
