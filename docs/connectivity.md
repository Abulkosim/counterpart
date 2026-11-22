# Connectivity

An identity can use several relays and move between them without pairing again. Contacts are told when your relays change. The daemon notices a dead connection within seconds, after sleep or a network change, and dials again. Nothing queued is lost.

## A Mac and a dev container on the same Mac

No tunnel and no internet. Run one relay on the Mac as a service, so it comes back after a restart ([relay.md](relay.md#on-your-own-machine)):

```sh
cpart relay --boot
```

With no `--url`, a relay that listens on this machine answers to `ws://127.0.0.1:7447`, `ws://localhost:7447`, `ws://[::1]:7447` and `ws://host.docker.internal:7447`. The last is the name a container uses for the machine it runs on.

On the Mac:

```sh
cpart setup --relay ws://127.0.0.1:7447
cpart invite container
```

In the container, run the line `cpart invite` printed, with your name for the Mac and `--yes` at the end:

```sh
cpart join 7-cider-otter@ws://127.0.0.1:7447 mac --yes
```

Inside a container, `ws://127.0.0.1:7447` is the container itself. `join` sees nothing answers there, tries `ws://host.docker.internal:7447`, and uses that. It records that the Mac calls the same relay `ws://127.0.0.1:7447`, so both sides know they share a relay. `--yes` accepts a relay on your own machine; without it, `join` asks, and without a terminal it stops and says to add `--yes`.

**This has not run on a Mac.** It ran on Linux, in `scripts/connectivity-smoke.sh`, with Bob in a `node:24-slim` container where `host.docker.internal` points at the relay. That machine's firewall drops traffic from containers to the host, so the relay itself ran in a container with its port published on the host's loopback; each side dialled the same names it would on a Mac. Docker's documentation says `host.docker.internal` reaches the host from a container on Docker Desktop. Whether it reaches a relay that listens only on 127.0.0.1 there is not known. If it does not, start the relay with `--host 0.0.0.0`, which also makes it reachable from your network.

### Checking it on your Mac

`scripts/mac-check.sh` answers that question on a real Mac with Docker Desktop and Node 24, and ends with a report to paste back:

```sh
./install.sh              # once, if this checkout has no node_modules yet
./scripts/mac-check.sh
```

It starts a relay on 127.0.0.1 only, makes an identity on the Mac with `cpart setup` and one in a `node:24-slim` container with `cpart join`. If the container cannot reach the relay through `host.docker.internal`, it restarts the relay on `0.0.0.0` and tries again. Then it times messages both ways and restarts the relay to count what is lost. Two steps ask first: installing the launchd agent and killing its daemon to see launchd start it again, and putting the Mac to sleep for a minute.

It leaves nothing behind. Both identities and the relay database live in a temp directory that is removed at the end. It uses `--no-agents`, points `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at empty temp directories, and never touches `~/.counterpart`. The launchd step writes a plist in `~/Library/LaunchAgents` and removes it; launchd keeps a note that the label was enabled and then disabled.

Steps 1 to 6 have run on Linux with Docker Engine, where the firewall above kept `host.docker.internal` from reaching the relay; the script then ran the container on the host's network and said so in its report. Nothing has run on a Mac.

## Several relays

```sh
cpart relay list                       # your relays, and what each contact knows
cpart relay add wss://relay-b.example  # use another relay too
cpart relay remove wss://relay-b.example
cpart relay move wss://relay-b.example # make it home, tell contacts, drop the old one when they confirm
```

Your daemon keeps a connection to every one of your relays and accepts mail on any of them. Your home relay is the one invites name.

`--as` gives a relay a second name: the address other people use for it, when you reach it by another. The container above does this by itself; by hand it is `cpart relay add ws://host.docker.internal:7448 --as ws://127.0.0.1:7448`. Invites name the relay by that second name, so an invite made inside the container names `ws://127.0.0.1:7448` and the Mac can accept it. Each relay has a random id in `/healthz`. `cpart relay add` refuses an address that is a relay you already use under another name, and says how to record it with `--as`.

### Telling contacts

When your list changes, your daemon sends each contact a `contact.relays` event: your relays, best first, and a version number that only grows. It is signed and sealed like every other message, and a contact applies it only to your entry. The contact's daemon answers with its own list and the version of yours it now holds. That answer is the confirmation. An unconfirmed list is sent again after a minute, then with a doubling wait up to an hour, then hourly until a week after the change, because a copy can land on a relay the contact does not read.

What a contact checks before applying it ([protocol.md](protocol.md#receiving-rules), gauntlet cases RLY-01 to RLY-09):

- It is from a contact. Strangers are refused.
- It changes only the sender's entry. Nobody's list can redirect your mail to anyone else.
- Its version is not lower than the one held, and not the same with a different list. A relay that holds back an old list and delivers it late is refused.
- Its version is not more than ten minutes ahead of the clock, and it does not claim to have seen a version of your list that does not exist.
- Every entry is a plain `ws://` or `wss://` address: no user name, query or fragment, nothing invisible, 1 to 16 of them, no two the same.

**A contact's list never makes your daemon dial anything.** Your daemon connects only to relays you added. If a contact moves to a relay you do not use, `cpart status` and `cpart relay list` say so and print the `cpart relay add` command. You decide.

### Sending

For each message, the daemon picks one of your own relays that the recipient listed, in the recipient's order. If that relay does not say it stored the message within ten seconds, it tries the next. If none of the relays the recipient listed has been reachable for 30 seconds, it uses your other relays, home first. With no relay in common at all, it uses those straight away.

The 30 second wait keeps a relay restart from sending someone's mail to a relay they never read. The price: after 30 seconds, mail can be stored on a relay the recipient does not read. It stays in your log, and the recipient's daemon asks for it again when a later message refers to it ([resend](protocol.md#resend-and-receipts)), but a last message with nothing after it can sit there until it expires.

### Moving

`cpart relay move <url>` makes `<url>` your home relay and keeps the old one, marked leaving, still connected. It then waits (60 seconds, or `--wait`) until every contact has confirmed your new list **and** uses a relay you are keeping. It also waits while an unused invite names the old relay, while a pairing you started has its answer coming through it, and while your daemon is not connected to it, since it may hold mail for you. Then it drops the old relay. If a contact has not caught up, it says who and why and keeps the old relay. Run the same command again later, or `cpart relay remove` the old one if you accept they may miss your mail.

A contact who does not use your new relay has to add it. That is a person's decision, for the reason above.

### After a tunnel restart

`cpart relay --tunnel` gets a new public address every start. Behind a tunnel the relay answers only to the tunnel's address, not to loopback names: every machine has those names, and through the public address a relay elsewhere could use one of them to log in as one of its own clients. To give it a local name that does not change, start it with one. The person who runs it dials it by that name, and tells contacts the tunnel's address:

```sh
cpart relay --tunnel --port 7447 --url ws://127.0.0.1:7447
cpart relay add ws://127.0.0.1:7447 --as wss://<name>.trycloudflare.com
```

If the tunnel's address is already one of your relays, this changes the address your daemon dials and keeps the relay's place in your list. Adding the local name as a relay of its own, with no `--as`, is refused: it is the same relay, and two connections to it would only replace each other.

The risk that comes with that name: a client who also uses some other relay that it reaches as `ws://127.0.0.1:7447` could be logged in to this one by that other relay. A less common port makes that less likely.

After a restart, run `cpart relay add ws://127.0.0.1:7447 --as wss://<new>.trycloudflare.com` and send the new address to the other person. They run `cpart relay move wss://<new>.trycloudflare.com`. Their daemon reaches the relay at the new address, you are still connected through 127.0.0.1, so their new list reaches you and your answer reaches them, and nobody pairs again. The new address still has to travel out of band: two people whose only relay changed address cannot tell each other through it. This recipe has not been run with a real tunnel; the smoke script runs the same move between two local relays.

## Connections that die quietly

For each relay (`packages/daemon/src/link.ts`):

- A connection quiet for 4 seconds is pinged. No answer in 4 more seconds and it is dropped, so a dead path is noticed within about 9 seconds. An answer can be stuck behind a message still being uploaded, so each byte sent and not yet confirmed adds time at 4 KB/s, up to two minutes. The wait before a send is tried again grows the same way, so a slow upload is not sent twice.
- Dialling and logging in must finish within 10 seconds.
- Once a second the daemon compares the wall clock with its timers. Timers stop while a machine sleeps; the wall clock does not. A gap of more than 5 seconds means it slept: every connection is dropped and dialled again at once.
- Once a second it also compares the machine's network addresses. When they change it pings each live connection and dials any that are down without waiting.
- Between failed attempts the wait starts at 250 ms and doubles up to 15 seconds, each time a random amount between half and all of it, so many daemons do not come back at the same moment.
- Nothing queued is lost. Outgoing mail leaves the outbox only when a relay says it stored it. Incoming mail is acknowledged only after it is recorded. A send in flight when the connection died is sent again; the relay and the recipient treat the same message twice as once.

## What was measured

`scripts/connectivity-smoke.sh` runs a relay in a container with its port published on the host's loopback, Alice on the host (`ws://127.0.0.1:PORT`), Dave on the host behind a TCP proxy that can black-hole traffic (`scripts/tcp-proxy.ts`), and Bob in a second container (`ws://host.docker.internal:PORT`). It breaks things and counts. Two runs on Linux, Node 24.22, 2 cores shared with other jobs: the first before review fixes at a load average around 3, the second on the final code at a load average of 11 ([verification.md](verification.md), 2026-11-17).

| Scenario | Detect (s) | Recover (s) | Sent | Read | Lost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Wi-Fi drop: proxy black-holes Dave's traffic for 8 s, closes nothing | 7.4 / 12.0 | 4.8 / 15.4 | 8 | 8 | 0 |
| Sleep: Dave's daemon SIGSTOPped 15 s with its network black-holed, then SIGCONT | - | 0.7 / 2.4 | 5 | 5 | 0 |
| Sleep with the network up: SIGSTOP 8 s, then SIGCONT | - | 0.7 / 1.8 | 3 | 3 | 0 |
| Relay killed with SIGKILL, down 5 s, started again on the same database | - | 7.4 / 14.5 | 8 | 8 | 0 |
| Bob's container disconnected from its docker network for 10 s | - | 3.6 / 8.8 | 6 | 6 | 0 |
| `cpart relay move` to a second relay (finished in 6.3 / 6.7 s), then the first relay killed | - | 6.0 / 22.4 | 6 | 6 | 0 |

"Detect" is from the fault to the daemon saying the connection was lost. "Recover" is from the fault ending to the last message being read on the other side. Times include the script's polling (0.1 s plus a `cpart log` process each time). For the black hole, "detect" starts before the script sends eight messages with eight `cpart` processes, so under load it overstates the daemon's own time. Recovery after the black hole is longer than after a sleep because a dial that started while traffic was dropped waits out its 10 second login limit. Nothing was refused on any side in either run.

Not tested: a real laptop sleeping, real Wi-Fi, macOS, a relay behind a real tunnel while it restarts, and relays on more than one machine. A contact on a version before v0.3.0 refuses `contact.relays` as an unknown type, so a move never finishes while they are a contact; `cpart relay remove` still works.

## The launchd agent

`cpart up --boot` on a Mac writes `~/Library/LaunchAgents/dev.counterpart.cpart[-<hash>].plist` and runs `launchctl load -w` on it. **It has never been loaded on a Mac.** `scripts/launchd-plist-check.ts` writes the file on Linux, with the platform reported as darwin and a stand-in `launchctl`, then parses it with Python's `plistlib`:

| Key | Value | Why |
| --- | --- | --- |
| `Label` | `dev.counterpart.cpart`, or `dev.counterpart.cpart-<8 hex>` for a home other than `~/.counterpart` | one agent per home |
| `ProgramArguments` | node's path, `packages/cli/src/main.ts`, `daemon` | the same command as `cpart daemon` |
| `EnvironmentVariables` | `CPART_HOME` (absolute), `PATH` (the shell's, when `up --boot` ran) | the front desk starts the `claude` CLI, which needs your PATH |
| `RunAtLoad` | true | start at login |
| `KeepAlive` | true | start again if it exits |
| `StandardOutPath`, `StandardErrorPath` | `<home>/daemon.log`, absolute | the same log as the other ways of running it |

It parsed, with a home path containing `&`, `<`, `>` and a space. Not checked: that launchd accepts the file, that `launchctl load -w` still works on current macOS (Apple lists `bootstrap` as its replacement), and what happens on sleep and wake under launchd. Step 7 of `scripts/mac-check.sh` checks the first two on a Mac.
