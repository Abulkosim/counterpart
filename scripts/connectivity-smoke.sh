#!/usr/bin/env bash
# Connections that die quietly, and relays that move. Real processes, no
# tunnel, no internet:
#   - The relay runs in a container whose port is published on this machine's
#     loopback, so Alice, here, reaches it as ws://127.0.0.1:PORT.
#   - Bob runs in another container and reaches the same relay as
#     ws://host.docker.internal:PORT, the name a dev container on a Mac uses
#     for the Mac. The relay is in a container because this machine's firewall
#     drops container-to-host traffic.
#   - Dave runs here behind a TCP proxy that can black-hole traffic.
#   - Carol runs here and pairs with an invite Bob made in his container.
# Then it breaks things and counts: Wi-Fi drop (black hole), sleep (SIGSTOP
# then SIGCONT), relay restart, Bob's container network unplugged, and a move
# to a second relay with `cpart relay move`, after which the first is gone.
# Prints how long each recovery took and how many messages were lost.
#
# Needs: node 24, docker, the node:24-slim image.
# Time:  not recorded.
# Cost:  nothing; no model, no internet.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
export CPART_NO_BOOT=1
# shellcheck source=smoke-lib.sh
. scripts/smoke-lib.sh
NAME=connectivity-$$
NET=$NAME-net
BOB=$NAME-bob
R1=$NAME-relay1
R2=$NAME-relay2
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
PROXY_PORT=$(free_port)
PORT2=$(free_port)
RESULTS=$WORK/results
IMAGE=node:24-slim

docker_cleanup() {
  local code=$?
  docker rm -f "$BOB" "$R1" "$R2" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  (exit "$code")
  cleanup
}
trap docker_cleanup EXIT

cpart() { local who=$1; shift; CPART_HOME="$WORK/$who" node packages/cli/src/main.ts "$@"; }
bob() { docker exec -e CPART_HOME=/tmp/bob -e CPART_NO_BOOT=1 "$BOB" node "$REPO/packages/cli/src/main.ts" "$@"; }
now() { date +%s.%N; }
since() { node -e "console.log((($(now)) - ($1)).toFixed(1))"; }
# wait_until <seconds> <description> <command...>
wait_until() {
  local limit=$1 what=$2; shift 2
  local end=$(( $(date +%s) + limit ))
  until "$@" >"$WORK/wait.out" 2>&1; do
    [ "$(date +%s)" -lt "$end" ] || fail "timed out after ${limit}s waiting for $what"
    sleep 0.1
  done
}
# How many lines of `cpart log` match a pattern, for one person.
seen() { local who=$1 contact=$2 pat=$3; if [ "$who" = bob ]; then bob log "$contact" | grep -c -- "$pat" || true; else cpart "$who" log "$contact" | grep -c -- "$pat" || true; fi; }
has() { [ "$(seen "$1" "$2" "$3")" -ge "$4" ]; }
all_seen() { while [ $# -gt 0 ]; do has "$1" "$2" "$3" "$4" || return 1; shift 4; done; }
record() { printf '%-34s %8s %8s %6s %6s %5s\n' "$@" >>"$RESULTS"; }
printf '%-34s %8s %8s %6s %6s %5s\n' scenario detect_s recover_s sent got lost >"$RESULTS"
# send <from> <to> <prefix> <n>
send() { local i; for i in $(seq 1 "$4"); do if [ "$1" = bob ]; then bob say "$2" "$3 $i" >/dev/null; else cpart "$1" say "$2" "$3 $i" >/dev/null; fi; done; }

# relay_container <name> <port>: an idle container that will run a relay, its port on this machine's loopback.
relay_container() {
  docker run -d --name "$1" --network "$NET" --user "$(id -u):$(id -g)" -p "127.0.0.1:$2:$2" \
    -v "$REPO:$REPO:ro" -v "$WORK:$WORK" -w "$REPO" "$IMAGE" sleep infinity >/dev/null
}
# relay_start <container> <port> <url>...: start the relay process in it and wait for it here.
relay_start() {
  local c=$1 port=$2 urls="" u; shift 2
  for u in "$@"; do urls="$urls --url $u"; done
  docker exec -d "$c" sh -c "node packages/cli/src/main.ts relay --host 0.0.0.0 --port $port --db $WORK/$c.db $urls >>$WORK/$c.log 2>&1 & echo \$! >$WORK/$c.pid; wait"
  wait_until 30 "relay $c" curl -sf "http://127.0.0.1:$port/healthz"
}
relay_kill() { docker exec "$1" sh -c "kill -9 \$(cat $WORK/$1.pid)"; }
ip_of() { docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$1"; }

step "two relay containers; the first answers to every name used here"
docker network create "$NET" >/dev/null
relay_container "$R1" "$PORT"
relay_container "$R2" "$PORT2"
relay_start "$R1" "$PORT" "ws://127.0.0.1:$PORT" "ws://host.docker.internal:$PORT" "ws://127.0.0.1:$PROXY_PORT"
grep "relay listening" "$WORK/$R1.log"
# Dave's network: a proxy that can black-hole.
node scripts/tcp-proxy.ts 127.0.0.1 "$PROXY_PORT" 127.0.0.1 "$PORT" >"$WORK/dave-proxy.log" 2>&1 &
DPROXY=$!
pids+=("$DPROXY")
wait_until 10 "the proxy" grep -q proxy "$WORK/dave-proxy.log"

step "Alice here, Dave behind his proxy"
cpart alice init --relay "ws://127.0.0.1:$PORT" --no-passphrase >/dev/null
cpart dave init --relay "ws://127.0.0.1:$PROXY_PORT" --no-passphrase >/dev/null
# Dave knows his proxy address is the relay Alice calls 127.0.0.1.
cpart dave relay add "ws://127.0.0.1:$PROXY_PORT" --as "ws://127.0.0.1:$PORT"
start_daemon alice
start_daemon dave

step "Bob in a container joins with Alice's invite, which names ws://127.0.0.1:$PORT"
docker run -d --name "$BOB" --network "$NET" --user "$(id -u):$(id -g)" \
  --add-host "host.docker.internal:$(ip_of "$R1")" --add-host "relay2.internal:$(ip_of "$R2")" \
  -v "$REPO:$REPO:ro" -w "$REPO" "$IMAGE" sleep infinity >/dev/null
INVITE=$(cpart alice invite bob --long | grep -o 'cpart-invite:[A-Za-z0-9_-]*')
bob join "$INVITE" alice --yes --no-agents --no-passphrase | tee "$WORK/bob.join"
grep -q "is ws://host.docker.internal:$PORT from here" "$WORK/bob.join" || fail "join did not find the relay by its container name"
grep -q "^Paired with alice" "$WORK/bob.join" || fail "Bob did not pair"
bob relay list | tee "$WORK/bob.relays"
grep -q "others call it ws://127.0.0.1:$PORT" "$WORK/bob.relays"

step "Bob, in the container, invites Carol on the host"
cpart carol init --relay "ws://127.0.0.1:$PORT" --no-passphrase >/dev/null
start_daemon carol
INVITE=$(bob invite carol --long | grep -o 'cpart-invite:[A-Za-z0-9_-]*')
# The invite names the relay as the host knows it, not as the container dials it.
node -e 'const { decodeInvite } = await import(process.argv[1]); console.log("invite names", decodeInvite(process.argv[2]).relay)' "$REPO/packages/protocol/src/index.ts" "$INVITE" | tee "$WORK/carol.invite"
grep -q "invite names ws://127.0.0.1:$PORT$" "$WORK/carol.invite" || fail "the container's invite does not name the host's address"
cpart carol accept "$INVITE" bob >/dev/null
wait_until 30 "Carol's pairing" sh -c "CPART_HOME='$WORK/carol' node packages/cli/src/main.ts contacts | grep -q 'bob .*active'"
bob open carol "from the container" >/dev/null
bob say carol "hello carol" >/dev/null
wait_until 15 "Carol to read Bob" has carol bob "hello carol" 1
cpart carol say bob "hello container" >/dev/null
wait_until 15 "Bob to read Carol" has bob carol "hello container" 1

step "the same relay under a second name is refused"
if cpart alice relay add "ws://localhost:$PORT" >"$WORK/dup.out" 2>&1; then cat "$WORK/dup.out"; fail "relay add took the same relay twice"; fi
cat "$WORK/dup.out"
grep -q "is the same relay as ws://127.0.0.1:$PORT" "$WORK/dup.out" || fail "relay add did not say why"

step "Alice pairs with Dave"
INVITE=$(cpart alice invite dave --long | grep -o 'cpart-invite:[A-Za-z0-9_-]*')
cpart dave accept "$INVITE" alice >/dev/null
wait_until 15 "the pairing" sh -c "CPART_HOME='$WORK/dave' node packages/cli/src/main.ts contacts | grep -q 'alice .*active'"

step "they talk: host to container and back, host to host"
cpart alice open bob "connectivity" >/dev/null
cpart alice say bob "hello container" >/dev/null
wait_until 15 "Bob to read Alice" has bob alice "hello container" 1
bob say alice "hello host" >/dev/null
wait_until 15 "Alice to read Bob" has alice bob "hello host" 1
cpart alice open dave "resilience" >/dev/null
cpart alice say dave "hello dave" >/dev/null
wait_until 15 "Dave to read Alice" has dave alice "hello dave" 1
cpart dave say alice "hello alice" >/dev/null
wait_until 15 "Alice to read Dave" has alice dave "hello alice" 1
cpart alice log bob

step "Wi-Fi drop: Dave's proxy black-holes traffic for 8 seconds and closes nothing"
before=$(count "relay connection lost" "$WORK/dave.log")
t0=$(now)
kill -USR1 "$DPROXY"
send alice dave "bh-a" 5
send dave alice "bh-d" 3
wait_until 30 "Dave's daemon to notice" sh -c "[ \$(grep -c 'relay connection lost' '$WORK/dave.log') -gt $before ]"
detect=$(since "$t0")
grep 'relay connection lost' "$WORK/dave.log" | tail -1
sleep 8
t1=$(now)
kill -USR2 "$DPROXY"
wait_until 60 "everything after the drop" all_seen dave alice bh-a 5 alice dave bh-d 3
got=$(( $(seen dave alice bh-a) + $(seen alice dave bh-d) ))
record "wifi drop (black hole)" "$detect" "$(since "$t1")" 8 "$got" "$(( 8 - got ))"

step "sleep: Dave's daemon stopped for 15 seconds, its network gone too"
kill -USR1 "$DPROXY"
kill -STOP "$dave_PID"
send alice dave "sl-a" 5
sleep 15
t1=$(now)
kill -USR2 "$DPROXY"
kill -CONT "$dave_PID"
wait_until 60 "Dave to catch up" has dave alice "sl-a" 5
grep -E "woke after" "$WORK/dave.log" | tail -1 || fail "the wake was not noticed"
record "sleep 15s, no network" "-" "$(since "$t1")" 5 "$(seen dave alice sl-a)" "$(( 5 - $(seen dave alice sl-a) ))"

step "sleep with the network up: SIGSTOP 8 seconds, then SIGCONT"
kill -STOP "$dave_PID"
send alice dave "st-a" 3
sleep 8
t1=$(now)
kill -CONT "$dave_PID"
wait_until 60 "Dave to catch up" has dave alice "st-a" 3
record "sleep 8s, network up" "-" "$(since "$t1")" 3 "$(seen dave alice st-a)" "$(( 3 - $(seen dave alice st-a) ))"

step "relay restart: killed, down 5 seconds, started again on the same port and database"
relay_kill "$R1"
send alice bob "rr-a" 3
send alice dave "rr-d" 3
send bob alice "rr-b" 2
sleep 5
t1=$(now)
relay_start "$R1" "$PORT" "ws://127.0.0.1:$PORT" "ws://host.docker.internal:$PORT" "ws://127.0.0.1:$PROXY_PORT"
wait_until 60 "everyone to catch up" all_seen bob alice rr-a 3 dave alice rr-d 3 alice bob rr-b 2
got=$(( $(seen bob alice rr-a) + $(seen dave alice rr-d) + $(seen alice bob rr-b) ))
record "relay restart (down 5s)" "-" "$(since "$t1")" 8 "$got" "$(( 8 - got ))"

step "Bob's container network unplugged for 10 seconds"
docker network disconnect "$NET" "$BOB"
send alice bob "nd-a" 4
send bob alice "nd-b" 2
sleep 10
t1=$(now)
docker network connect "$NET" "$BOB"
wait_until 60 "both sides to catch up" all_seen bob alice nd-a 4 alice bob nd-b 2
got=$(( $(seen bob alice nd-a) + $(seen alice bob nd-b) ))
docker exec "$BOB" sh -c 'grep -E "relay connection lost|network changed|connected to" /tmp/bob/daemon.log | tail -4'
record "container network unplugged 10s" "-" "$(since "$t1")" 6 "$got" "$(( 6 - got ))"

step "a second relay, and Alice moves her home to it"
relay_start "$R2" "$PORT2" "ws://127.0.0.1:$PORT2" "ws://relay2.internal:$PORT2"
# Without this Alice's move cannot finish: Dave would have no way to reach her.
cpart dave relay add "ws://127.0.0.1:$PORT2"
# Bob reaches relay 2 by another name, and says what the others call it.
bob relay add "ws://relay2.internal:$PORT2" --as "ws://127.0.0.1:$PORT2"
t0=$(now)
cpart alice relay move "ws://127.0.0.1:$PORT2" --wait 90 | tee "$WORK/alice.move"
grep -q "^Done. Every contact confirmed" "$WORK/alice.move" || fail "the move did not finish"
echo "move took $(since "$t0")s"
cpart alice relay list

step "relay 1 goes away for good; they still talk, through relay 2"
relay_kill "$R1"
t0=$(now)
send alice bob "mv-a" 2
send bob alice "mv-b" 2
send dave alice "mv-d" 2
wait_until 90 "mail through relay 2" all_seen bob alice mv-a 2 alice bob mv-b 2 alice dave mv-d 2
got=$(( $(seen bob alice mv-a) + $(seen alice bob mv-b) + $(seen alice dave mv-d) ))
record "after move, old relay gone" "-" "$(since "$t0")" 6 "$got" "$(( 6 - got ))"

step "what was refused (should be nothing)"
for who in alice dave carol; do echo "$who: $(cpart "$who" rejects)"; done
echo "bob: $(bob rejects)"

step "results"
cat "$RESULTS"
awk 'NR > 1 && $(NF) != 0 { bad = 1 } END { exit bad }' "$RESULTS" || fail "messages were lost"
for who in alice dave carol; do [ "$(cpart "$who" rejects)" = "Nothing has been refused." ] || fail "$who refused something"; done
[ "$(bob rejects)" = "Nothing has been refused." ] || fail "bob refused something"
echo
echo "CONNECTIVITY SMOKE OK"
