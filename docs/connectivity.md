# Connectivity

Two things used to go wrong. An identity was tied to one relay address, so when the address changed (a `cpart relay --tunnel` restart gives a new one) everyone on it had to start again. And a connection could die without closing, when a laptop slept or Wi-Fi changed, and nothing noticed for a long time.

Now an identity can use several relays, contacts are told when that changes, and the daemon notices a dead connection within seconds.

## A Mac and a dev container on the same Mac

No tunnel and no internet. One relay on the Mac:

```sh
cpart relay --port 7447
```

With no `--url`, a relay that listens on this machine answers to `ws://127.0.0.1:7447`, `ws://localhost:7447`, `ws://[::1]:7447` and `ws://host.docker.internal:7447`. The last is the name a container uses for the machine it runs on.

The project on the Mac:

```sh
cpart setup --relay ws://127.0.0.1:7447
cpart invite container
```

The project in the container, with the invite:

```sh
cpart join cpart-invite:... mac --yes
```

The invite names `ws://127.0.0.1:7447`. Inside a container that is the container itself, so `join` sees nothing answers there, tries `ws://host.docker.internal:7447`, and uses that. It remembers that the Mac calls the same relay `ws://127.0.0.1:7447`, so each side knows the other is on the same relay. `--yes` accepts a relay on your own machine; without it, `join` asks.

What was run: this flow on Linux, in `scripts/connectivity-smoke.sh`, with the invite naming `ws://127.0.0.1:PORT` and Bob in a `node:24-slim` container where `host.docker.internal` points at the relay. On that machine a firewall drops traffic from containers to the host, so the relay itself runs in a container with its port published on the host's loopback; each side dials the same names as on a Mac. **Nothing here was run on a Mac.** Docker's documentation says `host.docker.internal` reaches the host from a container on Docker Desktop. Whether it reaches a relay that listens only on 127.0.0.1 there has not been checked. If it does not, start the relay with `--host 0.0.0.0`, which also makes it reachable from your network.

## Several relays

```sh
cpart relay list                       # your relays, and what each contact knows
cpart relay add wss://relay-b.example  # use another relay too
cpart relay remove wss://relay-b.example
cpart relay move wss://relay-b.example # make it home, tell contacts, drop the old one when they confirm
```

Your daemon keeps a connection to every one of your relays and accepts mail on any of them. Your home relay is the one invites name.

`--as` gives a relay a second name: the address other people use for it, when you reach it by another. The container above does this by itself; by hand it is `cpart relay add ws://host.docker.internal:7448 --as ws://127.0.0.1:7448`. Invites name the relay by that second name, so an invite made inside the container names `ws://127.0.0.1:7448` and the Mac can accept it. Each relay has a random id in `/healthz`; `cpart relay add` refuses an address that is a relay you already use under another name, and says how to record it with `--as` instead.

### Telling contacts

When your list changes, your daemon sends each contact a `contact.relays` event: your relays, best first, and a version number that only grows. It is signed and sealed like every other message, so it can only come from you, and a contact applies it only to your entry. The contact's daemon answers with its own list and the version of yours it now holds. That answer is the confirmation. An unconfirmed list is sent again after a minute, then with a doubling wait up to an hour, and then hourly until a week after the change. A copy can land on a relay the contact does not read, so a few tries are not enough. A contact on an older version refuses every copy, so it gets one an hour for that week.

What a contact receiving it checks ([protocol.md](protocol.md#receiving-rules), gauntlet cases RLY-01 to RLY-09):

- It is from a contact. Strangers are refused.
- It changes only the sender's entry. Nobody's list can change where your mail to anyone else goes.
- Its version is not lower than the one held, and not the same with a different list. A relay that holds back an old list and delivers it late is refused. Replaying the same message is a duplicate.
- Its version is not more than ten minutes ahead of the clock, and it does not claim to have seen a version of your list that does not exist.
- Every entry is a plain `ws://` or `wss://` address: no user name, query or fragment, nothing invisible, 1 to 16 of them, no two the same.

**A contact's list never makes your daemon dial anything.** Your daemon connects only to relays you added. If a contact moves to a relay you do not use, `cpart status` and `cpart relay list` say so and print the `cpart relay add` command; you decide.

### Sending

For each message, the daemon picks one of your own relays that the recipient listed, in the recipient's order. If that relay does not say it stored the message within ten seconds, the next one. If none of the relays the recipient listed has been reachable for 30 seconds, it uses your other relays, home first. With no relay in common at all, it uses those straight away; that is where all mail went before.

The 30 second wait is there because a relay that restarts must not send someone's mail to a relay they never read. The price: after 30 seconds, mail can be stored on a relay the recipient does not read. It stays in your log, and the recipient's daemon asks for it again when a later message refers to it ([resend](protocol.md#resend-and-receipts)), but a last message with nothing after it can sit there until it expires.

### Moving

`cpart relay move <url>` makes `<url>` your home relay and keeps the old one, marked leaving, still connected. It then waits (60 seconds, or `--wait`) until every contact has confirmed your new list **and** uses a relay you are keeping. Then it drops the old relay. If someone has not, it says who and why and keeps the old relay; run the same command again later, or `cpart relay remove` the old one if you accept they may miss your mail.

A contact who does not use your new relay has to add it. That is a person's decision, for the reason above.

### After a tunnel restart

`cpart relay --tunnel` gets a new public address every start. Behind a tunnel the relay answers only to the tunnel's address, not to loopback names by default: every machine has those names, and through the public address a relay elsewhere could use one of them to log in as one of its own clients. To give it a local name that does not change, start it with one. The person who runs it then dials it by that name, and tells contacts the tunnel's address:

```sh
cpart relay --tunnel --port 7447 --url ws://127.0.0.1:7447
cpart relay add ws://127.0.0.1:7447 --as wss://<name>.trycloudflare.com
```

If the tunnel's address is already one of your relays, this changes the address your daemon dials and keeps the relay's place in your list. Adding the local name as a relay of its own, with no `--as`, is refused: it is the same relay, and two connections to it would only replace each other. (If a daemon does end up with two names for one relay, it notices and keeps one connection.)

The risk that comes with that name: a client who also uses some other relay that it reaches as `ws://127.0.0.1:7447` could be logged in to this one by that other relay. A less common port makes that less likely.

After a restart, run `cpart relay add ws://127.0.0.1:7447 --as wss://<new>.trycloudflare.com` and send the new address to the other person. They run `cpart relay move wss://<new>.trycloudflare.com`. Their daemon reaches the relay at the new address, and you are still connected through 127.0.0.1, so their new list reaches you and your answer reaches them; the move finishes and nobody pairs again. The new address still has to travel out of band: two people whose only relay changed address have no way to tell each other through it. This recipe was not run with a real tunnel; the smoke script runs the same move between two local relays.

## Connections that die quietly

In `packages/daemon/src/link.ts`, for each relay:

- A connection that has been quiet for 4 seconds is pinged. No answer in 4 more seconds and it is dropped. So a dead path is noticed within about 9 seconds. Relays from this version answer a `ping` frame; with an older relay the daemon uses WebSocket pings instead, because an older relay closes the connection on a frame it does not know.
- Dialling and logging in must finish within 10 seconds.
- Once a second the daemon checks the wall clock against its timers. Timers do not run while a machine sleeps or a process is stopped; the wall clock does. A gap of more than 5 seconds means it slept: every connection is dropped and dialled again at once.
- Every second it also compares the machine's network addresses. When they change it pings each live connection at once and dials any that are down without waiting.
- Between failed attempts the wait starts at 250 ms and doubles up to 15 seconds, each time a random amount between half and all of it, so many daemons do not come back at the same moment.
- Nothing queued is lost. Outgoing mail is in the database and leaves the outbox only when a relay says it stored it. Incoming mail is acknowledged only after it is recorded. A send that was in flight when the connection died is sent again; the relay and the recipient both treat the same message twice as once.

## What was measured

`scripts/connectivity-smoke.sh` runs a relay in a container with its port published on the host's loopback, Alice on the host (`ws://127.0.0.1:PORT`), Dave on the host behind a TCP proxy that can black-hole traffic (`scripts/tcp-proxy.ts`), and Bob in a second container (`ws://host.docker.internal:PORT`). The relay is in a container because this machine's firewall drops traffic from containers to the host; the names each side uses are the ones a Mac and its dev container would use. It breaks things and counts. Two runs on Linux (Node 24.22, 2 cores shared with other jobs). The first was before the review fixes, with a load average around 3; the second on the final code, with a load average of 11:

| Scenario | Detect (s) | Recover (s) | Sent | Read | Lost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Wi-Fi drop: proxy black-holes Dave's traffic for 8 s, closes nothing | 7.4 / 12.0 | 4.8 / 15.4 | 8 | 8 | 0 |
| Sleep: Dave's daemon SIGSTOPped 15 s with its network black-holed, then SIGCONT | - | 0.7 / 2.4 | 5 | 5 | 0 |
| Sleep with the network up: SIGSTOP 8 s, then SIGCONT | - | 0.7 / 1.8 | 3 | 3 | 0 |
| Relay killed with SIGKILL, down 5 s, started again on the same database | - | 7.4 / 14.5 | 8 | 8 | 0 |
| Bob's container disconnected from its docker network for 10 s | - | 3.6 / 8.8 | 6 | 6 | 0 |
| `cpart relay move` to a second relay (finished in 6.3 / 6.7 s), then the first relay killed | - | 6.0 / 22.4 | 6 | 6 | 0 |

Nothing was refused on any side in either run. "Detect" for the black hole starts before the script sends eight messages with eight `cpart` processes, so under load it overstates the daemon's own time. After the black hole, Dave's log said `no answer to a ping in 4s`; after the stop, `woke after 20s`; Bob's said `network changed` when the container lost and regained its network. Recovery after the black hole is longer than after a sleep because a dial that started while traffic was dropped waits out its 10 second login limit.

"detect" is from the fault to the daemon saying the connection was lost. "recover" is from the fault ending to the last message being read on the other side. Times include the script's polling (0.1 s plus a `cpart log` process each time).

Not tested: a real laptop sleeping, real Wi-Fi, macOS, a relay behind a real tunnel while it restarts, more than one relay process on more than one machine, and a contact running an older version (it refuses `contact.relays` as an unknown type, so a move would never finish while they are a contact; `cpart relay remove` still works).

## The launchd agent

`cpart up --boot` on a Mac writes `~/Library/LaunchAgents/dev.counterpart.cpart[-<hash>].plist` and runs `launchctl load -w` on it. It has never been loaded on a Mac. `scripts/launchd-plist-check.ts` writes the file here, with the platform reported as darwin and a stand-in `launchctl`, then parses it with Python's `plistlib`:

| Key | Value | Why |
| --- | --- | --- |
| `Label` | `dev.counterpart.cpart`, or `dev.counterpart.cpart-<8 hex>` for a home other than `~/.counterpart` | one agent per home |
| `ProgramArguments` | node's path, `packages/cli/src/main.ts`, `daemon` | the same command as `cpart daemon` |
| `EnvironmentVariables` | `CPART_HOME` (absolute), `PATH` (the shell's, when `up --boot` ran) | the front desk starts the `claude` CLI, which needs your PATH |
| `RunAtLoad` | true | start at login |
| `KeepAlive` | true | start again if it exits |
| `StandardOutPath`, `StandardErrorPath` | `<home>/daemon.log`, absolute | the same log as the other ways of running it |

It parsed, with a home path containing `&`, `<`, `>` and a space. Comparing the parsed fields with the code turned up one fault, now fixed: the log paths were written as given, so a relative `CPART_HOME` would have given launchd a relative path (the systemd unit already made them absolute). A relative home was not run through the check itself. Not checked: that launchd accepts the file, that `launchctl load -w` still works on current macOS (Apple lists `bootstrap` as its replacement), and what happens on sleep and wake under launchd.
