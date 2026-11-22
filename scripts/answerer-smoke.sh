#!/usr/bin/env bash
# The front desk answering from a real Git repository. Alice shares parts of a
# repository with Bob; his questions are answered from what is committed there,
# with citations that Alice's daemon checks. Canaries sit in an uncommitted
# edit, an untracked file, a file outside the share, .env, a file holding a
# key, a plain password in YAML and a file in a secrets directory; none may
# reach the model or Bob. Sharing must be refused when it does not come from
# Alice.
#
# The model is a local stand-in for the Messages API
# (scripts/answerer-fake-model.mjs), so this checks the plumbing and the
# checks, not answer quality. scripts/answerer-eval/ runs real models.
#
# Needs: node 24, git.
# Time:  156 s on a shared 2-core machine.
# Cost:  nothing; no model is called.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/smoke-lib.sh
# Alice has a passphrase: sharing files needs it, or a terminal and a typed word.
export CPART_NO_BOOT=1 CPART_PASSPHRASE="answerer smoke passphrase"
cpart() { local who=$1; shift; env -u ANTHROPIC_API_KEY CPART_HOME="$WORK/$who" node packages/cli/src/main.ts "$@"; }
field() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
canary() { echo "CANARY-$1-$(node -pe "require('crypto').randomBytes(5).toString('hex')")"; }

step "a stand-in model, a relay, alice and bob"
node scripts/answerer-fake-model.mjs "$WORK/model.port" "$WORK/model-saw.txt" >>"$WORK/model.log" 2>&1 &
pids+=("$!")
wait_for "the stand-in model" test -s "$WORK/model.port"
MODEL_URL=http://127.0.0.1:$(cat "$WORK/model.port")
start_relay
cpart alice init --relay "$RELAY" >/dev/null
cpart bob init --relay "$RELAY" --no-passphrase >/dev/null
start_daemon alice ANTHROPIC_API_KEY=fake ANTHROPIC_BASE_URL="$MODEL_URL"
start_daemon bob
cpart bob accept "$(cpart alice invite bob --json | field .invite)" alice >/dev/null
wait_for "pairing" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts contacts | grep -q 'bob .*active'"

step "a repository with things that must not be shared"
R=$WORK/repo
C_EDIT=$(canary edit) C_UNTRACKED=$(canary untracked) C_OUTSIDE=$(canary outside) C_ENV=$(canary env) C_KEY=$(canary key)
C_PW=$(canary pw) C_SECRETDIR=$(canary secretdir)
mkdir -p "$R/docs" "$R/internal" "$R/config/secrets"
printf 'smtp:\n  user: app\n  password: %s\n' "$C_PW" >"$R/config/mail.yml"
printf 'production:\n  host: db\n  note: %s\n' "$C_SECRETDIR" >"$R/config/secrets/db.yml"
g() { git -C "$R" -c user.name=t -c user.email=t@t "$@"; }
g init -q -b main
printf '# Orders API\n\nGET /orders uses cursor pagination.\nThe page size is 50.\n' >"$R/docs/orders.md"
printf 'Private plans: %s\n' "$C_OUTSIDE" >"$R/internal/plans.md"
printf 'DEPLOY_TOKEN=%s\n' "$C_ENV" >"$R/.env"
printf 'export const deployKey = "AKIAIOSFODNN7EXAMPLE"; // %s\n' "$C_KEY" >"$R/config/deploy.ts"
g add -A && g commit -qm first
printf 'The page size is 999. %s\n' "$C_EDIT" >>"$R/docs/orders.md"
printf '%s\n' "$C_UNTRACKED" >"$R/docs/draft.md"

step "an agent cannot share for alice: no terminal, no --yes, or a wrong passphrase"
if cpart alice share bob --repo "$R" docs </dev/null >"$WORK/gate1.out" 2>&1; then fail "a share without a terminal was accepted"; fi
grep -q "needs you, not your agent" "$WORK/gate1.out"
if env -u CPART_PASSPHRASE CPART_HOME="$WORK/alice" node packages/cli/src/main.ts share bob --repo "$R" docs --yes </dev/null >"$WORK/gate2.out" 2>&1; then fail "--yes without the passphrase was accepted"; fi
grep -q "only for scripts that set CPART_PASSPHRASE" "$WORK/gate2.out"
if CPART_PASSPHRASE=wrong cpart alice share bob --repo "$R" docs --yes </dev/null >"$WORK/gate3.out" 2>&1; then fail "a wrong passphrase was accepted"; fi
grep -q "wrong passphrase" "$WORK/gate3.out"
cpart alice share list bob | grep -q "Nothing from a repository is shared with bob" || fail "a refused share was saved"

step "alice shares docs, .env and config with bob"
cpart alice share bob --repo "$R" docs .env "config/**" --yes 2>"$WORK/share.err" | tee "$WORK/share.out"
grep -q "covers files you commit there later" "$WORK/share.err"
grep -q "can read 1 file" "$WORK/share.out" || fail "expected exactly one shared file"
grep -q "^  docs/orders.md$" "$WORK/share.out"
grep -q "^  .env  credentials; never shared$" "$WORK/share.out"
grep -q "^  config/deploy.ts  looks like it holds an AWS access key (line 1)$" "$WORK/share.out"
grep -q "^  config/mail.yml  looks like it holds a value assigned to password (line 3)$" "$WORK/share.out"
grep -q "^  config/secrets/db.yml  named as a secret; share it with --allow config/secrets/db.yml$" "$WORK/share.out"
if cpart alice share bob --repo "$R" docs/draft.md --yes >"$WORK/untracked.out" 2>&1; then fail "an untracked file was accepted"; fi
grep -q "matches nothing committed at HEAD" "$WORK/untracked.out"
if cpart alice share bob --repo "$R" ../../etc --yes >"$WORK/escape.out" 2>&1; then fail "a path outside the repository was accepted"; fi
# Turning the desk on first has alice's daemon make one tiny model call.
cpart alice desk on bob --as Alice >/dev/null
grep -q "front desk check: the model runs" "$WORK/alice.log" || fail "desk on did not check the model through the daemon"
cpart alice desk status | tee "$WORK/status.out"
grep -q "1 repository file(s)" "$WORK/status.out"

THREAD=$(cpart bob open alice "Questions about the orders API" --json | field .threadId)
replies() { cpart bob log "$THREAD" --json | node -pe "JSON.parse(require('fs').readFileSync(0)).filter(e => !e.mine && e.type === 'talk.posted').length"; }
last() { cpart bob log "$THREAD" --json | node -pe "JSON.parse(require('fs').readFileSync(0)).filter(e => !e.mine && e.type === 'talk.posted').at(-1).body.text"; }
ask() {
  local before; before=$(replies)
  cpart bob say "$THREAD" "$1" >/dev/null
  wait_for "a reply to: $1" sh -c "[ \$(CPART_HOME='$WORK/bob' node packages/cli/src/main.ts log '$THREAD' --json | node -pe \"JSON.parse(require('fs').readFileSync(0)).filter(e => !e.mine && e.type === 'talk.posted').length\") -gt $before ]"
}

step "bob asks something the shared file answers"
ask "How does GET /orders paginate?"
last | tee "$WORK/r1.txt"
grep -q '\[docs/orders.md:3 "GET /orders uses cursor pagination."\]' "$WORK/r1.txt" || fail "no checked citation in the answer"

step "bob asks for the deploy key; the reply cites a file that is not shared"
ask "What is the deploy key?"
last | tee "$WORK/r2.txt"
grep -q "passed the question to Alice" "$WORK/r2.txt" || fail "the desk did not pass it to Alice"
grep -q "config/deploy.ts" "$WORK/r2.txt" && fail "the uncheckable line reached bob"
cpart alice asks | tee "$WORK/asks.out"
grep -q "deploy key" "$WORK/asks.out"
# The desk answered in alice's name, so the thread is not also listed as unanswered.
cpart alice status | tee "$WORK/alice.status"
grep -q "^  1 question your front desk could not answer" "$WORK/alice.status" || fail "status does not list the question"
if grep -q "bob wrote in thread" "$WORK/alice.status"; then fail "a thread the desk answered is listed as unanswered"; fi

step "alice commits a change; the next answer reads it without sharing again"
printf '# Orders API\n\nGET /orders uses cursor pagination.\nThe page size is 75.\n' >"$R/docs/orders.md"
g commit -qam "bigger pages"
printf 'The page size is 999. %s\n' "$C_EDIT" >>"$R/docs/orders.md"
ask "What is the page size?"
last | tee "$WORK/r3.txt"
grep -q 'docs/orders.md:4 "The page size is 75."' "$WORK/r3.txt" || fail "the new commit was not read"

step "what alice's daemon recorded"
grep "front desk" "$WORK/alice.log"
grep -q "front desk answered .*commit [0-9a-f]\{12\}, all shared text shown, 1 citation checked, 0 lines removed, 4 files skipped" "$WORK/alice.log"
grep -q "front desk asked_human .*1 line removed (cited config/deploy.ts, which is not shared)" "$WORK/alice.log"

step "no canary reached the model or bob"
for c in "$C_EDIT" "$C_UNTRACKED" "$C_OUTSIDE" "$C_ENV" "$C_KEY" "$C_PW" "$C_SECRETDIR"; do
  if grep -q "$c" "$WORK/model-saw.txt"; then fail "the model saw $c"; fi
  if cpart bob log "$THREAD" --json | grep -q "$c"; then fail "bob received $c"; fi
done
[ "$(grep -c 'end of system prompt' "$WORK/model-saw.txt")" -eq 4 ] || fail "expected four model calls: the check and three answers"
[ "$(grep -c 'This is a check that you can be reached' "$WORK/model-saw.txt")" -eq 1 ] || fail "expected one check"

step "bob opens a thread with the question only in its goal and sends nothing"
GOAL_THREAD=$(cpart bob open alice "What is the page size of GET /orders?" --json | field .threadId)
goal_replies() { cpart bob log "$GOAL_THREAD" --json | node -pe "JSON.parse(require('fs').readFileSync(0)).filter(e => !e.mine && e.type === 'talk.posted').map(e => e.body.text).join('\\n')"; }
goal_count() { cpart bob log "$GOAL_THREAD" --json | node -pe "JSON.parse(require('fs').readFileSync(0)).filter(e => !e.mine && e.type === 'talk.posted').length"; }
OPENED_AT=$(date +%s)
# The desk waits 20 seconds for a message before it takes the goal as the question.
sleep 12
[ "$(goal_count)" -eq 0 ] || fail "the desk answered the goal before its wait was over"
for _ in $(seq 1 60); do [ "$(goal_count)" -gt 0 ] && break; sleep 1; done
goal_replies | tee "$WORK/r-goal.txt"
echo "answered about $(($(date +%s) - OPENED_AT)) s after the thread was opened"
grep -q 'docs/orders.md:4 "The page size is 75."' "$WORK/r-goal.txt" || fail "the goal was not answered from the share"
sleep 3
[ "$(goal_count)" -eq 1 ] || fail "the goal was answered more than once"

step "a goal that is a title: the desk waits for the message, however late"
asks_before=$(cpart alice asks --all --json | field .length)
GOAL_THREAD=$(cpart bob open alice "Orders API" --json | field .threadId)
sleep 25
[ "$(goal_count)" -eq 0 ] || fail "the desk answered a title"
cpart bob say "$GOAL_THREAD" "What is the page size of GET /orders?" >/dev/null
for _ in $(seq 1 60); do [ "$(goal_count)" -gt 0 ] && break; sleep 1; done
goal_replies | tee "$WORK/r-title.txt"
grep -q 'docs/orders.md:4 "The page size is 75."' "$WORK/r-title.txt" || fail "the message after a title was not answered"
sleep 3
[ "$(goal_count)" -eq 1 ] || fail "two replies to a title and a message"
[ "$(cpart alice asks --all --json | field .length)" -eq "$asks_before" ] || fail "a title reached alice's asks"

step "cpart open --say sends the first message with the thread"
GOAL_THREAD=$(cpart bob open alice "Orders API again" --say "What is the page size of GET /orders?" --json | field .threadId)
for _ in $(seq 1 60); do [ "$(goal_count)" -gt 0 ] && break; sleep 1; done
goal_replies | grep -q 'The page size is 75.' || fail "the first message sent with --say was not answered"

step "the repository moves away; bob is told, and the question goes to alice"
mv "$R" "$R.moved"
ask "Is there a rate limit?"
last | tee "$WORK/r4.txt"
grep -q "I can't answer right now. I've passed the question to Alice." "$WORK/r4.txt" || fail "no notice when the share could not be read"
grep -q "$WORK" "$WORK/r4.txt" && fail "the notice named a path"
cpart alice asks | grep -q "rate limit" || fail "the question did not reach alice's asks"
grep -q "front desk failed .*could not read what is shared" "$WORK/alice.log"
mv "$R.moved" "$R"

step "alice's daemon runs a claude that is not logged in and exits 1"
# A stand-in for the claude CLI, first on the daemon's PATH, so the real one
# is never started. It answers like claude with no login, and like a logged-in
# claude once a file says so.
STUB=$WORK/stub-bin
mkdir -p "$STUB" "$WORK/alice-claude"
cat >"$STUB/claude" <<'SH'
#!/bin/sh
cat >/dev/null
echo call >>"$CLAUDE_CONFIG_DIR/calls"
echo '{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}'
if [ -f "$CLAUDE_CONFIG_DIR/logged-in" ]; then
  echo '{"type":"result","is_error":false,"result":"ok"}'
  exit 0
fi
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in"}]},"error":"authentication_failed"}'
echo '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'
exit 1
SH
chmod +x "$STUB/claude"
kill "$alice_PID"
wait "$alice_PID" 2>/dev/null || true
# An empty ANTHROPIC_API_KEY means none: the daemon uses the claude CLI.
start_daemon alice ANTHROPIC_API_KEY= PATH="$STUB:$PATH" CLAUDE_CONFIG_DIR="$WORK/alice-claude"
calls() { cat "$WORK/alice-claude/calls" 2>/dev/null | wc -l; }

step "cpart desk on checks the model and refuses, naming the PATH and config the daemon used"
cpart alice desk off bob >/dev/null
if cpart alice desk on bob --as Alice >"$WORK/check1.out" 2>&1; then fail "desk on did not refuse a model that cannot run"; fi
cat "$WORK/check1.out"
grep -q "cannot run from the daemon: claude is not logged in (CLAUDE_CONFIG_DIR=$WORK/alice-claude)" "$WORK/check1.out"
grep -q "^  claude      $STUB/claude$" "$WORK/check1.out"
grep -q "^  PATH        $STUB:" "$WORK/check1.out"
grep -q "^Fix: log claude in for the daemon's config: CLAUDE_CONFIG_DIR=$WORK/alice-claude claude auth login$" "$WORK/check1.out"
grep -q "^Nothing was changed. To turn the desk on anyway: cpart desk on bob --as Alice --no-check$" "$WORK/check1.out"
cpart alice desk status | grep -q "^bob  *off " || fail "a refused desk on turned the desk on"
[ "$(calls)" -eq 1 ] || fail "the check should be one call"

step "turned on anyway: bob is told his question went to alice, alice sees why, nothing loops"
cpart alice desk on bob --as Alice --no-check >/dev/null
ask "What is the rate limit for GET /orders?"
last | tee "$WORK/r5.txt"
[ "$(last)" = "This is Alice's front desk. I can't answer right now. I've passed the question to Alice." ] || fail "bob did not get the fixed notice"
grep -q -e "$WORK" -e "logged in" -e "CLAUDE" "$WORK/r5.txt" && fail "the reason reached bob"
cpart alice asks | tee "$WORK/asks5.out"
grep -A1 "rate limit for GET" "$WORK/asks5.out" | grep -q "not answered because the model could not run (claude is not logged in)" || fail "alice's ask does not say why"
cpart alice status | tee "$WORK/status5.out"
grep -q "front desk failing: claude is not logged in, since " "$WORK/status5.out" || fail "cpart status does not show the failing desk"
grep -q "front desk failed .*claude is not logged in" "$WORK/alice.log"
[ "$(calls)" -eq 2 ] || fail "expected the check and one answer"
sleep 3
[ "$(calls)" -eq 2 ] || fail "the desk tried the message again"

step "with the desk on, a change is refused too, and the desk stays on as it was"
if cpart alice desk on bob --slots 3 >"$WORK/check3.out" 2>&1; then fail "desk on did not refuse a model that cannot run"; fi
grep -q "^Nothing was changed. The desk is still on as before. To make the change anyway: cpart desk on bob --slots 3 --no-check$" "$WORK/check3.out"
cpart alice desk status | grep -q "^bob  *on .* 6 replies per thread" || fail "a refused desk on changed the desk"

step "alice logs claude in; the check passes and the status clears"
touch "$WORK/alice-claude/logged-in"
cpart alice desk check | tee "$WORK/check2.out"
grep -q "It works" "$WORK/check2.out"
cpart alice status >"$WORK/status6.out"
grep -q "front desk failing" "$WORK/status6.out" && fail "the status still shows the desk failing"

step "share list and remove"
cpart alice share list bob
cpart alice share remove bob --all
ask "Anything else?"
last | grep -q "Nothing has been shared with you" || fail "with nothing shared the desk should say so"

step "bob's log"
cpart bob log "$THREAD"
echo
echo "ANSWERER SMOKE OK"
