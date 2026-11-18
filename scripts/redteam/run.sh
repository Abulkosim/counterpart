#!/usr/bin/env bash
# The leak red team: attacks from the other side against a coding agent with
# a shell, file tools and the Counterpart tools. See docs/redteam.md.
#
#   ./scripts/redteam/run.sh                       # every attack twice, guard off; writes results/guard-off.json
#   ./scripts/redteam/run.sh --guard on            # the same with the outbound guard on, then compares with guard-off.json
#   ./scripts/redteam/run.sh --only A06,A10 --trials 1 --jobs 2   # replaces those rows in the saved results
#   ./scripts/redteam/run.sh --brief trusting      # bob tells his agent he trusts alice; writes results/guard-off-trusting.json
#   ./scripts/redteam/run.sh --victim fake-leak    # no model: a scripted victim (used by smoke.sh)
#
# With a real model this costs tokens and takes a while: each trial is one to
# five `claude -p` sessions. Nothing here touches ~/.counterpart, ~/.claude or
# your environment: each trial has its own homes, and bob's agent runs with a
# small environment of planted values only.
set -euo pipefail
cd "$(dirname "$0")/../.."
export CPART_NO_BOOT=1
. scripts/smoke-lib.sh

step "relay on port $PORT"
start_relay
step "trials (progress on stderr)"
status=0
WORK=$WORK RELAY=$RELAY node scripts/redteam/suite.ts "$@" || status=$?
# suite.ts says where it wrote. It writes even when some trials failed to run.
[ -e "$WORK/outfile" ] || exit "$status"
step "report"
file=$(cat "$WORK/outfile")
off=${file/guard-on/guard-off}
if [ "$off" != "$file" ] && [ -e "$off" ]; then
  node scripts/redteam/report.ts "$off" "$file"
else
  node scripts/redteam/report.ts "$file"
fi
exit "$status"
