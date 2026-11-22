#!/usr/bin/env bash
# One project on a Mac, one in a Docker Desktop dev container on the same Mac:
# does Counterpart work between them? Run it once from this checkout:
#
#   ./scripts/mac-check.sh
#
# It prints a report to paste back. What it does:
#   1. reads the macOS, Docker and node versions, and runs a container
#   2. starts a relay on 127.0.0.1 only, on a free port, with its database in a temp dir
#   3. makes a Mac identity in a temp dir (cpart setup --no-agents --no-passphrase)
#   4. makes a container identity with cpart join, using the code cpart invite printed
#      on the Mac. The question: does host.docker.internal reach a relay that listens
#      on the Mac's 127.0.0.1? If not, it tries again with the relay on 0.0.0.0
#   5. sends messages both ways and times them
#   6. restarts the relay and counts what was lost
#   7. asks first: installs the launchd agent for the temp identity, kills the daemon,
#      checks launchd starts it again, then removes the agent
#   8. asks first: you put the Mac to sleep for a minute; it checks both daemons
#      come back and nothing sent around the sleep is lost
#
# What it leaves behind: nothing it can remove. Identities and the relay database
# live in a temp dir that is deleted at the end. Your ~/.counterpart, Claude Code
# and Codex settings are not touched (--no-agents, and CLAUDE_CONFIG_DIR and
# CODEX_HOME point at empty temp dirs). The relay, the daemons and the containers
# are stopped, and the node image is removed if this script pulled it. Step 7 writes
# a plist in ~/Library/LaunchAgents and removes it again; launchctl itself keeps a
# note that the label was enabled and then disabled.
#
# It also runs on Linux with docker (host.docker.internal is then added with
# --add-host ...:host-gateway). Kept to what the bash 3.2 that ships with macOS has.
# MAC_CHECK_KEEP=1 keeps the temp dir for reading the logs afterwards.
#
# Needs: node 24, Docker Desktop (or docker on Linux).
# Cost:  nothing; no model, no internet beyond pulling node:24-slim if missing.
# Steps 7 and 8 wait for you.
set -u
cd "$(dirname "$0")/.." || exit 1
REPO=$(pwd)
OS=$(uname -s)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/cpart-mac-check.XXXXXX") || exit 1
REPORT=$WORK/report
: >"$REPORT"
NAME=cpart-mac-check-$$
IMAGE=${MAC_CHECK_IMAGE:-node:24-slim}
CHOME=/root/cpart
CONT=
CONTAINERS=
PULLED=
BG=
RELAY_PID=
RELAY_HOST=127.0.0.1
PORT=
LABEL=
PLIST=
MADE_AGENTS_DIR=
FAILS=0
STARTED=$(date +%s)

# No step may reach your own identity or agent settings.
export CPART_NO_BOOT=1 CLAUDE_CONFIG_DIR=$WORK/no-claude CODEX_HOME=$WORK/no-codex
unset CPART_HOME CPART_RELAY CPART_PASSPHRASE CPART_RELAY_URL CPART_NO_AUTOSTART

say() { printf '%s\n' "$*"; }
head_line() { printf '\n== %s\n' "$*"; }
# result PASS|FAIL|SKIP <step> <detail>
result() {
  [ "$1" = FAIL ] && FAILS=$((FAILS + 1))
  printf '%-4s %-4s %s\n' "$1" "$2" "$3" | tee -a "$REPORT"
}
note() { printf '     %s\n' "$*" | tee -a "$REPORT"; }
# The last lines of a log, for the terminal only: logs can hold paths with your user name.
show_tail() { [ -s "$2" ] && { printf -- '---- last lines of %s\n' "$1"; tail -n "${3:-15}" "$2" | cat -v; }; }
now_ms() { node -p 'Date.now()'; }
secs() { node -p "(($1) / 1000).toFixed(1)"; }
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
count_in() {
  local n
  n=$(grep -c -F -- "$1" "$2" 2>/dev/null)
  echo "${n:-0}"
}

mac() { CPART_HOME="$WORK/mac" node "$REPO/packages/cli/src/main.ts" "$@"; }
cont() { docker exec -e CPART_HOME="$CHOME" -e CPART_NO_BOOT=1 -w /work "$CONT" node packages/cli/src/main.ts "$@"; }
cont_log() { docker exec "$CONT" cat "$CHOME/daemon.log" 2>/dev/null; }

cleanup() {
  local code=$?
  trap - EXIT INT TERM HUP
  # shellcheck disable=SC2086 # a list of pids
  [ -n "$BG" ] && kill $BG 2>/dev/null
  [ -e "$WORK/mac/keys.json" ] && mac down >/dev/null 2>&1
  # Belt and braces for step 7: if `cpart down` did not take the agent out, do it here.
  if [ -n "$PLIST" ] && [ -e "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl unload -w "$PLIST" >/dev/null 2>&1
    rm -f "$PLIST"
  fi
  [ -n "$MADE_AGENTS_DIR" ] && rmdir "$HOME/Library/LaunchAgents" 2>/dev/null
  if [ -n "$RELAY_PID" ]; then kill "$RELAY_PID" 2>/dev/null; wait "$RELAY_PID" 2>/dev/null; fi
  # shellcheck disable=SC2086 # a list of names
  [ -n "$CONTAINERS" ] && docker rm -f $CONTAINERS >/dev/null 2>&1
  [ -n "$PULLED" ] && docker rmi "$IMAGE" >/dev/null 2>&1
  if [ "${MAC_CHECK_KEEP:-}" = 1 ]; then say "Kept $WORK"; else rm -rf "$WORK"; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# ask <question>: y/N. No when this is not a terminal.
ask() {
  [ -t 0 ] || return 1
  local a
  printf '\n%s [y/N] ' "$1"
  read -r a || return 1
  case $a in y | Y | yes | YES) return 0 ;; esac
  return 1
}

# wait_until <seconds> <command...>: polls every 0.2 s.
wait_until() {
  local limit=$1 end
  shift
  end=$(($(date +%s) + limit))
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$end" ] || return 1
    sleep 0.2
  done
}

# How many lines of one side's log with a contact hold <text>.
seen() { if [ "$1" = mac ]; then mac log container | grep -c -F -- "$2"; else cont log mac | grep -c -F -- "$2"; fi; }
has() { [ "$(seen "$1" "$2")" -ge "${3:-1}" ]; }

# A new "connected to" line in a daemon's log since <count>.
mac_connected_since() { [ "$(count_in "connected to" "$WORK/mac/daemon.log")" -gt "$1" ]; }
cont_connected_since() { [ "$(cont_log | grep -c -F 'connected to')" -gt "$1" ]; }
# What the daemon says now, from its state file.
mac_connected_now() { grep -q '"connected":true' "$WORK/mac/daemon.json" 2>/dev/null; }
cont_connected_now() { docker exec "$CONT" cat "$CHOME/daemon.json" 2>/dev/null | grep -q '"connected":true'; }

start_relay() {
  local before
  RELAY_HOST=$1
  before=$(count_in "relay listening" "$WORK/relay.log")
  (cd "$WORK" && exec node "$REPO/packages/cli/src/main.ts" relay --host "$RELAY_HOST" --port "$PORT" --db "$WORK/relay.db") >>"$WORK/relay.log" 2>&1 &
  RELAY_PID=$!
  wait_until 30 sh -c "[ \$(grep -c 'relay listening' '$WORK/relay.log') -gt $before ] && curl -sf http://127.0.0.1:$PORT/healthz"
}
stop_relay() {
  [ -n "$RELAY_PID" ] || return 0
  kill "$RELAY_PID" 2>/dev/null
  wait "$RELAY_PID" 2>/dev/null
  RELAY_PID=
}
# Restart the relay on <host> and wait for the Mac daemon to log in again.
restart_relay() {
  local before
  before=$(count_in "connected to" "$WORK/mac/daemon.log")
  stop_relay
  start_relay "$1" || return 1
  wait_until 45 mac_connected_since "$before"
}

# What listens on the port, as lsof prints it: 127.0.0.1:PORT, *:PORT, ...
listening_on() {
  command -v lsof >/dev/null || { say "lsof not found"; return; }
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $9 }' | sort -u | paste -s -d ' ' -
}

# container <name>: a container with this checkout copied in and installed
# inside, so nothing built for macOS is used on Linux. Docker Desktop knows
# host.docker.internal by itself; elsewhere it is added.
container() {
  local name=$1 pm
  if [ "$DOCKER_DESKTOP" = 1 ]; then
    docker run -d --init --name "$name" -v "$REPO:/src:ro" "$IMAGE" sleep infinity >"$WORK/$name.run" 2>&1 || return 1
  else
    docker run -d --init --name "$name" --add-host host.docker.internal:host-gateway -v "$REPO:/src:ro" "$IMAGE" sleep infinity >"$WORK/$name.run" 2>&1 || return 1
  fi
  pm=$(node -p 'require("./package.json").packageManager || "pnpm@latest"')
  docker exec "$name" sh -c "mkdir -p /work && cd /src && tar -cf - --exclude=node_modules package.json pnpm-lock.yaml pnpm-workspace.yaml packages | tar -C /work -xf - \
    && npm install -g --silent $pm && cd /work && pnpm install --prod --frozen-lockfile" >"$WORK/$name.install" 2>&1
}

# invite <attempt>: starts `cpart invite container` on the Mac in the background.
# INVITE_CODE is the code it shows, INVITE_PID the waiting process. Not called
# in $(...): a subshell would lose both.
INVITE_PID=
INVITE_CODE=
invite() {
  local out=$WORK/invite.$1.out
  # exec, so the pid is node's own and a kill stops the wait, not just a subshell.
  (CPART_HOME="$WORK/mac" exec node "$REPO/packages/cli/src/main.ts" invite container) >"$out" 2>&1 &
  INVITE_PID=$!
  BG="$BG $INVITE_PID"
  wait_until 30 grep -q 'cpart join ' "$out" || return 1
  INVITE_CODE=$(grep -o 'cpart join [^ ]*' "$out" | head -n 1 | awk '{ print $3 }')
}

# try_join <attempt> <code>: the container joins with the code. JOIN_MS is how long it took.
JOIN_MS=
LAST_JOIN=
try_join() {
  local t0
  LAST_JOIN=$1
  t0=$(now_ms)
  cont join "$2" mac --no-agents --yes --no-passphrase >"$WORK/join.$1.out" 2>&1
  JOIN_MS=$(($(now_ms) - t0))
  grep -q '^Paired with mac' "$WORK/join.$1.out"
}
# What the container sees at host.docker.internal: the address it resolves to,
# and what a plain HTTP request to the relay's health check gets.
probe() {
  docker exec "$CONT" node --input-type=module -e '
const port = process.argv[1];
const dns = await import("node:dns/promises");
const addr = await dns.lookup("host.docker.internal").then((a) => a.address, (e) => e.code);
const got = await fetch(`http://host.docker.internal:${port}/healthz`, { signal: AbortSignal.timeout(5000) })
  .then((r) => `HTTP ${r.status}`, (e) => e.cause?.code ?? e.name);
console.log(`from the container, host.docker.internal is ${addr}; its /healthz on port ${port} gave ${got}`);
' "$PORT" 2>&1 | tail -n 1
}
# A failed attempt: stop waiting on the Mac.
drop_invite() { kill "$INVITE_PID" 2>/dev/null; wait "$INVITE_PID" 2>/dev/null; }

say "cpart mac-check. Logs and identities in a temp dir that is removed at the end."
say "Ctrl-C stops it and cleans up."

# ---- 1. environment
head_line "1. environment"
ENV_OK=1
if [ "$OS" = Darwin ]; then
  OSV="macOS $(sw_vers -productVersion 2>/dev/null) ($(uname -m))"
else
  OSV="$OS $(uname -r) ($(uname -m))"
fi
NODEV=$(node -v 2>/dev/null || say none)
DOCKER_DESKTOP=0
DOCKERV=none
DOCKER_RUNS=no
if command -v docker >/dev/null; then
  DOCKERV=$(docker version --format '{{.Server.Platform.Name}}, engine {{.Server.Version}}' 2>/dev/null || say "client only, no daemon answers")
  case $(docker info --format '{{.OperatingSystem}}' 2>/dev/null) in *"Docker Desktop"*) DOCKER_DESKTOP=1 ;; esac
fi
say "$OSV; node $NODEV; docker: $DOCKERV"
case $NODEV in v2[4-9]* | v[3-9][0-9]*) ;; *) ENV_OK=0; note "needs node 24 or newer on this machine" ;; esac
if [ ! -d "$REPO/node_modules" ]; then ENV_OK=0; note "no node_modules in this checkout: run ./install.sh or pnpm install first"; fi
HAD_IMAGE=1
if [ "$DOCKERV" != none ] && docker info >/dev/null 2>&1; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || HAD_IMAGE=0
  if [ "$HAD_IMAGE" = 0 ]; then say "pulling $IMAGE (removed again at the end)"; docker pull -q "$IMAGE" >"$WORK/pull.out" 2>&1 && PULLED=1; fi
  if docker run --rm "$IMAGE" node -e 'console.log("ok")' 2>"$WORK/docker-run.err" | grep -q ok; then DOCKER_RUNS=yes; else ENV_OK=0; fi
else
  ENV_OK=0
fi
DD=no
[ "$DOCKER_DESKTOP" = 1 ] && DD=yes
if [ "$ENV_OK" = 1 ]; then
  result PASS 1 "$OSV; node $NODEV; $DOCKERV; Docker Desktop: $DD; a $IMAGE container runs"
else
  result FAIL 1 "$OSV; node $NODEV; docker: $DOCKERV; Docker Desktop: $DD; container runs: $DOCKER_RUNS"
  show_tail "docker run" "$WORK/docker-run.err"
fi
# Docker on this machine's own kernel (Linux, not Docker Desktop): --network host is this machine's network.
NATIVE_DOCKER=0
[ "$DOCKER_DESKTOP" = 0 ] && [ "$(docker info --format '{{.KernelVersion}}' 2>/dev/null)" = "$(uname -r)" ] && NATIVE_DOCKER=1

# ---- 2. relay
RELAY_OK=0
if [ "$ENV_OK" = 1 ]; then
  head_line "2. a relay on 127.0.0.1 only"
  PORT=$(free_port)
  if start_relay 127.0.0.1; then
    RELAY_OK=1
    result PASS 2 "relay on port $PORT, listening on: $(listening_on)"
  else
    result FAIL 2 "the relay did not start on 127.0.0.1:$PORT"
    show_tail relay "$WORK/relay.log"
  fi
else
  result SKIP 2 "step 1 failed"
fi

# The container is installed while the Mac identity is made.
CONT_READY=
if [ "$RELAY_OK" = 1 ]; then
  CONT=$NAME-bridge
  # Named here: the install runs in a subshell, which cannot add to the list.
  CONTAINERS="$CONTAINERS $CONT"
  T_INSTALL=$(now_ms)
  (container "$CONT" && echo ok >"$WORK/install.done" || echo failed >"$WORK/install.done") &
  CONT_READY=$!
  BG="$BG $CONT_READY"
fi

# ---- 3. Mac identity
MAC_OK=0
if [ "$RELAY_OK" = 1 ]; then
  head_line "3. Mac identity"
  RELAY_URL=ws://127.0.0.1:$PORT
  if mac setup --relay "$RELAY_URL" --no-agents --no-passphrase >"$WORK/mac.setup" 2>&1 && grep -q "^ok  daemon started, connected" "$WORK/mac.setup"; then
    MAC_OK=1
    result PASS 3 "cpart setup --relay $RELAY_URL --no-agents --no-passphrase: identity made, daemon connected"
  else
    result FAIL 3 "cpart setup did not finish with a connected daemon"
    show_tail setup "$WORK/mac.setup"
    show_tail daemon "$WORK/mac/daemon.log"
  fi
else
  result SKIP 3 "no relay"
fi

# ---- 4. container identity
CONT_OK=0
VIA=
if [ "$MAC_OK" = 1 ]; then
  head_line "4. container identity, through host.docker.internal"
  say "waiting for the container install (pnpm install inside the container)"
  wait "$CONT_READY" 2>/dev/null
  if [ "$(cat "$WORK/install.done" 2>/dev/null)" != ok ]; then
    result FAIL 4 "could not start or install the container"
    show_tail "docker run" "$WORK/$CONT.run"
    show_tail install "$WORK/$CONT.install" 25
  else
    note "container ready in $(secs "$(now_ms) - $T_INSTALL") s (image $IMAGE; checkout copied in, pnpm install inside)"
    # 4a: the relay listens on the Mac's 127.0.0.1 only.
    if invite a && try_join a "$INVITE_CODE"; then
      CONT_OK=1
      VIA="host.docker.internal to a relay on 127.0.0.1"
      result PASS 4a "host.docker.internal reaches the relay on 127.0.0.1: joined and paired in $(secs "$JOIN_MS") s"
    else
      drop_invite
      result FAIL 4a "host.docker.internal did not reach the relay on 127.0.0.1 (join took $(secs "${JOIN_MS:-0}") s)"
      grep -E '^(ok|--) |no relay answers|refused|Error|error' "$WORK/join.a.out" 2>/dev/null | head -n 5 | sed 's/^/     join: /' | tee -a "$REPORT"
      note "$(probe)"
      # 4b: the documented fallback.
      say "trying again with the relay on 0.0.0.0, the documented fallback"
      if [ "$OS" = Darwin ]; then
        say "If macOS asks whether node may accept incoming connections, either answer is fine;"
        say "the report shows whether the container got through. macOS remembers the answer."
      fi
      if restart_relay 0.0.0.0 && invite b && try_join b "$INVITE_CODE"; then
        CONT_OK=1
        VIA="host.docker.internal to a relay on 0.0.0.0"
        result PASS 4b "with the relay on 0.0.0.0 (listening on: $(listening_on)) host.docker.internal reaches it: paired in $(secs "$JOIN_MS") s"
      else
        drop_invite
        result FAIL 4b "with the relay on 0.0.0.0 (listening on: $(listening_on)) host.docker.internal does not reach it either"
        grep -E '^(ok|--) |no relay answers|refused|Error|error' "$WORK/join.b.out" 2>/dev/null | head -n 5 | sed 's/^/     join: /' | tee -a "$REPORT"
        note "$(probe)"
        # 4c, Docker on Linux only: a host whose firewall drops container-to-host traffic. The
        # container shares the host's network, so it dials 127.0.0.1 like the host. Not the Mac path.
        if [ "$NATIVE_DOCKER" = 1 ] && restart_relay 127.0.0.1; then
          say "Docker on Linux: trying with the container on the host's network, so steps 5 and 6 can run"
          OLD=$CONT
          CONT=$NAME-hostnet
          if docker run -d --init --name "$CONT" --network host "$IMAGE" sleep infinity >"$WORK/$CONT.run" 2>&1; then
            CONTAINERS="$CONTAINERS $CONT"
            docker exec "$OLD" tar -C /work -cf - . | docker exec -i "$CONT" sh -c 'mkdir -p /work && tar -C /work -xf -'
            if invite c && try_join c "$INVITE_CODE"; then
              CONT_OK=1
              VIA="a container on the host's network (Docker on Linux fallback, not the Mac path)"
              result PASS 4c "container on --network host dials 127.0.0.1 itself: paired in $(secs "$JOIN_MS") s"
            else
              drop_invite
              result FAIL 4c "container on --network host did not pair either"
              show_tail join "$WORK/join.c.out"
            fi
          fi
        fi
      fi
    fi
    if [ "$CONT_OK" = 1 ]; then
      grep -q "is ws://host.docker.internal:$PORT from here" "$WORK/join.$LAST_JOIN.out" &&
        note "join said: ws://127.0.0.1:$PORT is ws://host.docker.internal:$PORT from here"
      if wait_until 30 grep -q '^Paired with container' "$WORK/invite.$LAST_JOIN.out"; then
        note "the Mac's cpart invite said: Paired with container"
      else
        note "the Mac's cpart invite had not said it paired 30 s after the container did"
      fi
      drop_invite
    fi
  fi
else
  result SKIP 4 "no Mac identity"
fi

# ---- 5. messages both ways
TALK_OK=0
if [ "$CONT_OK" = 1 ]; then
  head_line "5. messages both ways ($VIA)"
  TAG=$(node -p 'require("crypto").randomBytes(4).toString("hex")')
  M2C=
  C2M=
  LOST5=0
  for i in 1 2 3; do
    t0=$(now_ms)
    if [ "$i" = 1 ]; then mac open container "mac-check" --say "m2c $i $TAG" >/dev/null 2>"$WORK/send.err"; else mac say container "m2c $i $TAG" >/dev/null 2>"$WORK/send.err"; fi
    if wait_until 30 has container "m2c $i $TAG"; then M2C="$M2C $(secs "$(now_ms) - $t0")"; else LOST5=$((LOST5 + 1)); M2C="$M2C lost"; fi
    t0=$(now_ms)
    cont say mac "c2m $i $TAG" >/dev/null 2>>"$WORK/send.err"
    if wait_until 30 has mac "c2m $i $TAG"; then C2M="$C2M $(secs "$(now_ms) - $t0")"; else LOST5=$((LOST5 + 1)); C2M="$C2M lost"; fi
  done
  if [ "$LOST5" = 0 ]; then
    TALK_OK=1
    result PASS 5 "3 each way, none lost. Seconds from send to seen in the other side's cpart log: Mac to container$M2C; container to Mac$C2M"
  else
    result FAIL 5 "$LOST5 of 6 not seen within 30 s. Mac to container:$M2C; container to Mac:$C2M"
    show_tail send "$WORK/send.err"
  fi
  note "times include starting a cpart process to send and polling cpart log every 0.2 s"
else
  result SKIP 5 "no container identity"
fi

# ---- 6. relay restart
if [ "$TALK_OK" = 1 ]; then
  head_line "6. relay restart"
  stop_relay
  # Sent while the relay is down: they wait in each side's outbox.
  for i in 1 2 3; do
    mac say container "down-m2c $i $TAG" >/dev/null
    cont say mac "down-c2m $i $TAG" >/dev/null
  done
  sleep 3
  t0=$(now_ms)
  if start_relay "$RELAY_HOST"; then
    for i in 4 5 6; do
      mac say container "up-m2c $i $TAG" >/dev/null
      cont say mac "up-c2m $i $TAG" >/dev/null
    done
    end=$(($(date +%s) + 90))
    got=0
    while [ "$(date +%s)" -lt "$end" ]; do
      got=$(($(seen container "m2c ") + $(seen mac "c2m ")))
      # 3 + 3 from step 5, then 6 + 6 here.
      [ "$got" -ge 18 ] && break
      sleep 0.5
    done
    rec=$(secs "$(now_ms) - $t0")
    lost=$((18 - got))
    if [ "$lost" -le 0 ]; then
      result PASS 6 "relay stopped, 3 each way sent while down, relay started on the same database, 3 more each way: 12 sent, 12 seen, 0 lost; all in $rec s from the restart"
    else
      result FAIL 6 "12 sent around the restart, $((got - 6)) seen within 90 s, $lost lost"
    fi
  else
    result FAIL 6 "the relay did not start again"
    show_tail relay "$WORK/relay.log"
  fi
else
  result SKIP 6 "step 5 did not pass"
fi

# ---- 7. launchd
if [ "$OS" != Darwin ]; then
  result SKIP 7 "launchd is macOS only"
elif [ "$TALK_OK" != 1 ]; then
  result SKIP 7 "steps 5 or 6 did not run"
elif ! ask "7. Install the launchd agent for the temp identity, kill its daemon, check launchd restarts it, then remove it? A plist goes in ~/Library/LaunchAgents and is removed again. If macOS shows a notice about a background item, it is this one."; then
  result SKIP 7 "not chosen (or not a terminal)"
else
  head_line "7. launchd"
  LABEL=$(node -e 'const { createHash } = require("crypto"); const { resolve } = require("path"); console.log("dev.counterpart.cpart-" + createHash("sha256").update(resolve(process.argv[1])).digest("hex").slice(0, 8))' "$WORK/mac")
  PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
  [ -d "$HOME/Library/LaunchAgents" ] || MADE_AGENTS_DIR=1
  # The real path: setup without CPART_NO_BOOT, which installs the agent and starts the daemon under launchd.
  CPART_NO_BOOT=0 mac setup --no-agents >"$WORK/mac.boot" 2>&1
  P1=$(launchctl print "gui/$(id -u)/$LABEL" 2>&1)
  pid1=$(printf '%s\n' "$P1" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')
  state1=$(printf '%s\n' "$P1" | awk '$1 == "state" && $2 == "=" { $1 = ""; $2 = ""; sub(/^ +/, ""); print; exit }')
  if grep -q "starts at login" "$WORK/mac.boot" && [ -e "$PLIST" ] && [ "$state1" = running ] && [ -n "$pid1" ]; then
    result PASS 7a "cpart setup installed $LABEL; launchctl print: state = $state1, pid $pid1"
    # Counted before the kill: the new daemon may log in before launchctl shows its pid here.
    before=$(count_in "connected to" "$WORK/mac/daemon.log")
    t0=$(now_ms)
    kill -9 "$pid1"
    pid2=
    end=$(($(date +%s) + 60))
    while [ "$(date +%s)" -lt "$end" ]; do
      P2=$(launchctl print "gui/$(id -u)/$LABEL" 2>&1)
      pid2=$(printf '%s\n' "$P2" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')
      [ -n "$pid2" ] && [ "$pid2" != "$pid1" ] && break
      pid2=
      sleep 0.5
    done
    if [ -n "$pid2" ]; then
      restart=$(secs "$(now_ms) - $t0")
      if wait_until 30 mac_connected_since "$before"; then
        cont say mac "launchd $TAG" >/dev/null
        if wait_until 30 has mac "launchd $TAG"; then
          result PASS 7b "killed pid $pid1 with SIGKILL; launchd started pid $pid2 after $restart s; it reconnected and a message from the container arrived"
        else
          result FAIL 7b "launchd started pid $pid2 after $restart s, but a message from the container did not arrive in 30 s"
        fi
      else
        result FAIL 7b "launchd started pid $pid2 after $restart s, but it did not connect to the relay"
        show_tail daemon "$WORK/mac/daemon.log"
      fi
    else
      result FAIL 7b "killed pid $pid1; launchd did not start the daemon again within 60 s"
      printf '%s\n' "$P2" | grep -E '^\s*(state|pid|last exit|runs) ' | sed 's/^/     launchctl: /' | tee -a "$REPORT"
    fi
  else
    pl=missing
    [ -e "$PLIST" ] && pl=written
    result FAIL 7a "agent not running after cpart setup (plist $pl; launchctl state: ${state1:-none})"
    case $REPO in "$HOME"/Desktop/* | "$HOME"/Documents/* | "$HOME"/Downloads/*) note "this checkout is under Desktop, Documents or Downloads, which macOS can keep a launchd job from reading" ;; esac
    printf '%s\n' "$P1" | grep -E '^\s*(state|pid|last exit|runs) |Could not find' | sed 's/^/     launchctl: /' | tee -a "$REPORT"
    show_tail setup "$WORK/mac.boot"
    show_tail daemon "$WORK/mac/daemon.log"
  fi
  mac down >"$WORK/mac.down" 2>&1
  if [ ! -e "$PLIST" ] && ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    result PASS 7c "cpart down removed the plist, and launchctl print no longer finds $LABEL"
  else
    pl=gone
    [ -e "$PLIST" ] && pl="still there"
    job="has no job"
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && job="still has the job"
    result FAIL 7c "after cpart down: plist $pl; launchctl $job"
  fi
  # Back to a plain daemon for step 8.
  mac up >/dev/null 2>&1
fi

# ---- 8. sleep
if [ "$TALK_OK" != 1 ]; then
  result SKIP 8 "step 5 did not pass"
elif ! ask "8. Sleep test: you put this machine to sleep for about a minute (close the lid on battery, or Apple menu > Sleep), then wake it and press Enter. Do it?"; then
  result SKIP 8 "not chosen (or not a terminal)"
else
  head_line "8. sleep"
  wake_mac=$(count_in "woke after" "$WORK/mac/daemon.log")
  wake_cont=$(cont_log | grep -c -F "woke after")
  conn_mac=$(count_in "connected to" "$WORK/mac/daemon.log")
  conn_cont=$(cont_log | grep -c -F "connected to")
  : >"$WORK/sleep.sent"
  # Both sides send one message every 5 s until Enter, so some are sent just
  # before the sleep and some the moment the machine wakes, on dead connections.
  (
    i=0
    while [ ! -e "$WORK/sleep.stop" ]; do
      i=$((i + 1))
      mac say container "sleep-m2c $i $TAG" >/dev/null 2>&1 && echo m2c >>"$WORK/sleep.sent"
      cont say mac "sleep-c2m $i $TAG" >/dev/null 2>&1 && echo c2m >>"$WORK/sleep.sent"
      sleep 5
    done
  ) &
  SENDER=$!
  BG="$BG $SENDER"
  say "Both sides now send a message every 5 seconds."
  say "Put the machine to sleep now, for about a minute. Then wake it and press Enter."
  read -r _
  t0=$(now_ms)
  touch "$WORK/sleep.stop"
  wait "$SENDER" 2>/dev/null
  # One more each way, sent the moment you are back.
  mac say container "sleep-m2c wake $TAG" >/dev/null 2>&1 && echo m2c >>"$WORK/sleep.sent"
  cont say mac "sleep-c2m wake $TAG" >/dev/null 2>&1 && echo c2m >>"$WORK/sleep.sent"
  n_m2c=$(count_in m2c "$WORK/sleep.sent")
  n_c2m=$(count_in c2m "$WORK/sleep.sent")
  back_mac=-
  back_cont=-
  first_m2c=-
  first_c2m=-
  end=$(($(date +%s) + 120))
  while [ "$(date +%s)" -lt "$end" ]; do
    [ "$back_mac" = - ] && mac_connected_since "$conn_mac" && back_mac=$(secs "$(now_ms) - $t0")
    [ "$back_cont" = - ] && cont_connected_since "$conn_cont" && back_cont=$(secs "$(now_ms) - $t0")
    [ "$first_m2c" = - ] && has container "sleep-m2c wake $TAG" && first_m2c=$(secs "$(now_ms) - $t0")
    [ "$first_c2m" = - ] && has mac "sleep-c2m wake $TAG" && first_c2m=$(secs "$(now_ms) - $t0")
    g1=$(seen container "sleep-m2c ")
    g2=$(seen mac "sleep-c2m ")
    [ "$g1" -ge "$n_m2c" ] && [ "$g2" -ge "$n_c2m" ] && break
    sleep 0.5
  done
  all=$(secs "$(now_ms) - $t0")
  woke_mac=$(grep -F "woke after" "$WORK/mac/daemon.log" | tail -n +"$((wake_mac + 1))" | grep -o 'woke after [0-9]*s' | tail -n 1)
  woke_cont=$(cont_log | grep -F "woke after" | tail -n +"$((wake_cont + 1))" | grep -o 'woke after [0-9]*s' | tail -n 1)
  up_mac=no
  mac_connected_now && up_mac=yes
  up_cont=no
  cont_connected_now && up_cont=yes
  lost=$((n_m2c - g1 + n_c2m - g2))
  detail="sent $n_m2c Mac to container and $n_c2m back (the last of each right after Enter), seen $g1 and $g2, lost $lost; all seen ${all} s after Enter; the two sent after Enter seen after ${first_m2c} s (to container) and ${first_c2m} s (to Mac)"
  if [ "$lost" -le 0 ] && [ "$up_mac" = yes ] && [ "$up_cont" = yes ]; then result PASS 8 "$detail"; else result FAIL 8 "$detail"; fi
  note "Mac daemon: ${woke_mac:-logged no wake}; new login ${back_mac} s after Enter (- is none); connected now: $up_mac"
  note "container daemon: ${woke_cont:-logged no wake}; new login ${back_cont} s after Enter (- is none); connected now: $up_cont"
  [ -z "$woke_mac" ] && note "the Mac daemon logged no wake: if the machine did not really sleep, this step proves little"
fi

# ---- summary
TOOK=$(($(date +%s) - STARTED))
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || say unknown)
{
  printf '\n----- BEGIN cpart mac-check report: paste from here -----\n'
  printf 'date %s, commit %s, took %s s\n' "$(date -u +%Y-%m-%dT%H:%MZ)" "$COMMIT" "$TOOK"
  printf '%s; node %s; docker: %s; Docker Desktop: %s; image %s\n' "$OSV" "$NODEV" "$DOCKERV" "$DD" "$IMAGE"
  cat "$REPORT"
  printf 'failed: %s\n' "$FAILS"
  printf -- '----- END cpart mac-check report -----\n'
} | tee "$WORK/summary"
say "Cleaning up: relay, daemons, containers, temp dir."
[ "$FAILS" = 0 ]
