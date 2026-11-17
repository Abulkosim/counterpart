#!/usr/bin/env bash
# The front desk answering from a real Git repository: `cpart share`, a relay
# and two daemons as separate processes. Alice shares parts of a repository
# with Bob; Bob's questions are answered from what is committed there, with
# citations that Alice's daemon checks. Canaries sit in an uncommitted edit, an
# untracked file, a file outside the share, .env and a file holding a key;
# none may reach the model or Bob.
#
# The model is a local stand-in for the Messages API (scripts/answerer-fake-model.mjs),
# so this checks the plumbing and the checks, not answer quality. The eval in
# scripts/answerer-eval/ runs real models.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/smoke-lib.sh
export CPART_NO_BOOT=1
cpart() { local who=$1; shift; env -u ANTHROPIC_API_KEY CPART_HOME="$WORK/$who" node packages/cli/src/main.ts "$@"; }
field() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
canary() { echo "CANARY-$1-$(node -pe "require('crypto').randomBytes(5).toString('hex')")"; }

step "a stand-in model, a relay, alice and bob"
node scripts/answerer-fake-model.mjs "$WORK/model.port" "$WORK/model-saw.txt" >>"$WORK/model.log" 2>&1 &
pids+=("$!")
wait_for "the stand-in model" test -s "$WORK/model.port"
MODEL_URL=http://127.0.0.1:$(cat "$WORK/model.port")
start_relay
cpart alice init --relay "$RELAY" --no-passphrase >/dev/null
cpart bob init --relay "$RELAY" --no-passphrase >/dev/null
start_daemon alice ANTHROPIC_API_KEY=fake ANTHROPIC_BASE_URL="$MODEL_URL"
start_daemon bob
cpart bob accept "$(cpart alice invite bob --json | field .invite)" alice >/dev/null
wait_for "pairing" sh -c "CPART_HOME='$WORK/alice' node packages/cli/src/main.ts contacts | grep -q 'bob .*active'"

step "a repository with things that must not be shared"
R=$WORK/repo
C_EDIT=$(canary edit) C_UNTRACKED=$(canary untracked) C_OUTSIDE=$(canary outside) C_ENV=$(canary env) C_KEY=$(canary key)
mkdir -p "$R/docs" "$R/internal" "$R/config"
g() { git -C "$R" -c user.name=t -c user.email=t@t "$@"; }
g init -q -b main
printf '# Orders API\n\nGET /orders uses cursor pagination.\nThe page size is 50.\n' >"$R/docs/orders.md"
printf 'Private plans: %s\n' "$C_OUTSIDE" >"$R/internal/plans.md"
printf 'DEPLOY_TOKEN=%s\n' "$C_ENV" >"$R/.env"
printf 'export const deployKey = "AKIAIOSFODNN7EXAMPLE"; // %s\n' "$C_KEY" >"$R/config/deploy.ts"
g add -A && g commit -qm first
printf 'The page size is 999. %s\n' "$C_EDIT" >>"$R/docs/orders.md"
printf '%s\n' "$C_UNTRACKED" >"$R/docs/draft.md"

step "alice shares docs, .env and config with bob"
cpart alice share bob --repo "$R" docs .env "config/**" | tee "$WORK/share.out"
grep -q "can read 1 file" "$WORK/share.out" || fail "expected exactly one shared file"
grep -q "^  docs/orders.md$" "$WORK/share.out"
grep -q "^  .env  credentials; never shared$" "$WORK/share.out"
grep -q "^  config/deploy.ts  looks like it holds an AWS access key (line 1)$" "$WORK/share.out"
if cpart alice share bob --repo "$R" docs/draft.md >"$WORK/untracked.out" 2>&1; then fail "an untracked file was accepted"; fi
grep -q "matches nothing committed at HEAD" "$WORK/untracked.out"
if cpart alice share bob --repo "$R" ../../etc >"$WORK/escape.out" 2>&1; then fail "a path outside the repository was accepted"; fi
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
grep -q "front desk answered .*commit [0-9a-f]\{12\}, all shared text shown, 1 citation checked, 0 lines removed, 2 files skipped" "$WORK/alice.log"
grep -q "front desk asked_human .*1 line removed (cited config/deploy.ts, which is not shared)" "$WORK/alice.log"

step "no canary reached the model or bob"
for c in "$C_EDIT" "$C_UNTRACKED" "$C_OUTSIDE" "$C_ENV" "$C_KEY"; do
  if grep -q "$c" "$WORK/model-saw.txt"; then fail "the model saw $c"; fi
  if cpart bob log "$THREAD" --json | grep -q "$c"; then fail "bob received $c"; fi
done
[ "$(grep -c 'end of system prompt' "$WORK/model-saw.txt")" -eq 3 ] || fail "expected three model calls"

step "share list and remove"
cpart alice share list bob
cpart alice share remove bob --all
ask "Anything else?"
last | grep -q "Nothing has been shared with you" || fail "with nothing shared the desk should say so"

step "bob's log"
cpart bob log "$THREAD"
echo
echo "ANSWERER SMOKE OK"
