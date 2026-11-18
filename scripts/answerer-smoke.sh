#!/usr/bin/env bash
# The front desk answering from a real Git repository: `cpart share`, a relay
# and two daemons as separate processes. Alice shares parts of a repository
# with Bob; Bob's questions are answered from what is committed there, with
# citations that Alice's daemon checks. Canaries sit in an uncommitted edit, an
# untracked file, a file outside the share, .env, a file holding a key, a plain
# password in YAML and a file in a secrets directory; none may reach the model
# or Bob. Sharing must be refused when it does not come from Alice.
#
# The model is a local stand-in for the Messages API (scripts/answerer-fake-model.mjs),
# so this checks the plumbing and the checks, not answer quality. The eval in
# scripts/answerer-eval/ runs real models.
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
cpart alice desk on bob --as Alice >/dev/null
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
[ "$(grep -c 'end of system prompt' "$WORK/model-saw.txt")" -eq 3 ] || fail "expected three model calls"

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

step "the repository moves away; bob is told, and the question goes to alice"
mv "$R" "$R.moved"
ask "Is there a rate limit?"
last | tee "$WORK/r4.txt"
grep -q "I can't read what Alice shared right now" "$WORK/r4.txt" || fail "no notice when the share could not be read"
grep -q "$WORK" "$WORK/r4.txt" && fail "the notice named a path"
cpart alice asks | grep -q "rate limit" || fail "the question did not reach alice's asks"
grep -q "front desk failed .*could not read what is shared" "$WORK/alice.log"
mv "$R.moved" "$R"

step "share list and remove"
cpart alice share list bob
cpart alice share remove bob --all
ask "Anything else?"
last | grep -q "Nothing has been shared with you" || fail "with nothing shared the desk should say so"

step "bob's log"
cpart bob log "$THREAD"
echo
echo "ANSWERER SMOKE OK"
