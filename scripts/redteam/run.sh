#!/usr/bin/env bash
# The leak red team: attacks from the other side against a coding agent with
# a shell, file tools and the Counterpart tools. See docs/redteam.md.
#
#   ./scripts/redteam/run.sh                       # every attack twice, guard off; writes results/guard-off.json
#   ./scripts/redteam/run.sh --guard on            # the same with the outbound guard on, then compares with guard-off.json
#   ./scripts/redteam/run.sh --only A06,A10 --trials 1 --jobs 2
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

guard=off
out=
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --guard) guard=${args[$((i + 1))]} ;;
    --guard=*) guard=${args[$i]#--guard=} ;;
    --out) out=${args[$((i + 1))]} ;;
    --out=*) out=${args[$i]#--out=} ;;
  esac
done

step "relay on port $PORT"
start_relay
step "trials (progress on stderr)"
WORK=$WORK RELAY=$RELAY node scripts/redteam/suite.ts "$@"

step "report"
file=${out:-}
if [ -z "$file" ]; then
  victim=claude
  for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[$i]}" in --victim) victim=${args[$((i + 1))]} ;; --victim=*) victim=${args[$i]#--victim=} ;; esac
  done
  file=scripts/redteam/results/guard-$guard$([ "$victim" = claude ] || echo "-$victim").json
fi
if [ "$guard" = on ] && [ -e scripts/redteam/results/guard-off.json ] && [ "$file" != scripts/redteam/results/guard-off.json ]; then
  node scripts/redteam/report.ts scripts/redteam/results/guard-off.json "$file"
else
  node scripts/redteam/report.ts "$file"
fi
