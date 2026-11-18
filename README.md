# Counterpart

Counterpart lets your AI agent talk to someone else's AI agent.

You say "sort this out with Maya's agent". The two agents talk through a relay. They reach an agreement, and both humans approve it. The first use is two developers whose coding agents (Claude Code, Codex) need to agree on something across two repos.

The relay cannot read your messages. Each person runs a small daemon that holds their keys and checks every action against rules they set. The other side's messages are treated as untrusted input, always.

## Status

Experimental. The encryption has not been reviewed by anyone outside the project. Do not rely on it for secrets yet.

| Milestone | What works | State |
| --- | --- | --- |
| M0 | Two paired daemons exchange encrypted messages through a relay and survive duplicate, delayed and reordered delivery | Done |
| M1 | Front desk: your agent answers a contact's questions from material you approved, while you are away. MCP tools for Claude Code and Codex. Local viewer | Done |
| M2 | Two agents negotiate a contract; both humans approve the same hash | Done |
| M3 | Workers write patches; each side gets a PR with signed evidence | Worker, verifier and `cpart pr` done and run on GitHub once. Evidence between the two sides done (`cpart evidence`), run locally. Evidence on the pull request and in CI is next |
| M4 | Two devices, smoothly and safely | One-command setup, pairing with a short code, several relays per identity and moving relays, reconnecting after sleep and network changes, replies that reach a live Claude Code session, answers from your real repository, and a guard that holds secrets before they leave. Run between containers on one Linux host. Nobody hosts a relay for you yet, and nothing has run on a Mac |

## Set up

Needs Node 24. Each person does this once:

```sh
git clone https://github.com/Abulkosim/counterpart && cd counterpart && ./install.sh
cpart setup --relay wss://your-relay     # or: cpart join <code> <name>, if someone invited you
```

`cpart setup` creates your identity, starts the daemon in the background (and at login), and adds the Counterpart tools and hooks to Claude Code and Codex. Run it again any time; it only does what is missing.

Then pair. One person runs `cpart invite maya`. It prints a short code and the line to send, and waits. Maya runs the line:

```sh
cpart join 7-cider-otter@relay.example.com sam   # sam is what Maya calls the person who invited her
```

That one command is Maya's whole setup: identity, daemon, tools, and the pairing. There is no safety code to compare: the code itself proves the two sides reached each other and not someone in between ([docs/pairing.md](docs/pairing.md)). A wrong word ends the code on both sides. You can read the code aloud over a call.

Now open Claude Code or Codex in your repo and say what you want:

> Ask Maya's agent what their orders API returns for an empty page, and agree on a page size.

When Maya's agent replies, your session is told on its next step, or woken if it is idle (interactive Claude Code). The notice never contains Maya's text, only that something arrived. Your agent reads the reply through its tools, wrapped as untrusted input.

Anything your side sends passes the outbound guard first. A message that carries a secret (a key of a known shape, a value from your environment, `.env`, config or credential files, or a file you marked never-share, also reversed, encoded, spelled out or in pieces) is held, and your agent is told only that it was held. You release it with `cpart release` and your passphrase, at a terminal. See [docs/guard.md](docs/guard.md).

`cpart status` shows whether everything is running and what is waiting for you: a held message, a contract to read, a question your front desk could not answer.

No relay yet? `cpart relay --tunnel` runs one on your machine with a public address, good for trying it together. [docs/relay.md](docs/relay.md) has the container for a permanent one. If the relay moves, `cpart relay move <new>` takes your contacts with you ([docs/connectivity.md](docs/connectivity.md)).

One project on your Mac and one in a dev container on the same Mac: run the relay on the Mac (`cpart relay`), `cpart setup --relay ws://127.0.0.1:7447` on the Mac, and in the container the line `cpart invite` printed on the Mac (`cpart join 7-cider-otter@ws://127.0.0.1:7447 <name>`). Inside a container, `join` finds a relay on 127.0.0.1 at `host.docker.internal`, and the relay answers to both names. This was run with Linux containers, not with Docker Desktop on a Mac.

## Check it yourself

```sh
pnpm install
pnpm verify              # types and tests
./scripts/smoke.sh       # two people and a relay as real processes
./scripts/setup-smoke.sh    # the short path above: setup, join, background daemons
./scripts/pairing-smoke.sh  # pairing with a short code: wrong word, typo, burned code, killed daemon
./scripts/connectivity-smoke.sh # several relays, a relay move, dead links and sleep. Counts messages lost
./scripts/delivery-smoke.sh # hooks that tell a session a reply arrived, with the real claude and codex
./scripts/answerer-smoke.sh # the front desk answers from a repository's committed files, citations checked
./scripts/guard-smoke.sh    # held messages, release at a terminal, guard off
./scripts/devices/rig.sh    # two Docker "devices" with live Claude sessions, sleep, network drops. Uses real models
./scripts/redteam/run.sh    # a tool-using agent with planted secrets, 24 attacks to make it leak. Uses real models
./scripts/two-machines.sh   # the same across the internet: one side in a container, relay behind a public tunnel. Needs docker and cloudflared
./scripts/contract-smoke.sh # two people sign an agreement and verify it
./scripts/evidence-smoke.sh # one tells the other what their repository holds; a changed byte shows as a mismatch
./scripts/demo-publish.sh    # the whole path on GitHub. Creates a private repo
./scripts/demo-work.sh       # after an agreement, a worker proposes the patch. Uses real models
./scripts/demo-agents.sh   # Bob's Claude Code session asks Alice's front desk. Uses real models
./scripts/demo-negotiate.sh # two Claude Code sessions negotiate a contract; the script approves it as the two humans. Uses real models
```

There is a [demo video](demo/README.md) drawn from a recording of one real run: `cd demo && npm install && node capture.mjs && node render.mjs`.

## Every command

The pieces by hand, in three terminals:

```sh
pnpm cpart relay --port 7447
CPART_HOME=/tmp/alice pnpm cpart init --relay ws://127.0.0.1:7447 && CPART_HOME=/tmp/alice pnpm cpart daemon
CPART_HOME=/tmp/bob   pnpm cpart init --relay ws://127.0.0.1:7447 && CPART_HOME=/tmp/bob   pnpm cpart daemon
```

Pair: `cpart invite bob` as Alice, `cpart join <code> alice` as Bob. Or the long way: `cpart invite bob --long` and `cpart accept <invite> alice`, then compare the safety code out of band.

Talk: `cpart open alice "goal"`, `cpart say <thread> "text"`, `cpart log <thread>`. Wherever a command takes a thread, a contact's name means your latest thread with them: `cpart log alice`.

Agree on something:

```sh
cpart propose <thread> --title "Orders pagination" --file contract.md --part json-schema:page.schema.json
cpart contracts <thread>                 # lists proposals with their ids
cpart approve <thread> <id>              # shows the text, asks for your passphrase, cannot be undone
cpart agreement export <thread> <id> --out agreement.json
cpart agreement verify agreement.json    # works anywhere, no database needed
```

Turn an agreement into a patch:

```sh
cpart work <thread> <id> --repo . --paths src/orders.js,schemas --brief "Implement the agreed pagination"
cpart work show <work-id>                # read it. Nothing has been written
cpart work apply <work-id> <work-hash>   # writes the files, commits nothing
```

Publish it:

```sh
cpart repo init <thread> <id> --repo . --bind page.schema.json=schemas/page.schema.json   # once; commit the result to main
cpart pr <thread> <id> --work <work-id>   # shows what will be pushed, then opens the pull request
```

Then run the `Counterpart verify` workflow from your main branch with the pull request's number.

Let your agent answer for you while you are away:

```sh
cpart share bob --repo . docs src/api   # the front desk reads these from your last commit, and cites them
cpart bundle add bob docs/api.md      # or: copies of files, as before
cpart desk on bob --as Alice --slots 6
cpart asks                                  # questions it could not answer
cpart asks answer 1 "300 requests a minute" # sent to bob as your own message
cpart asks dismiss 2                        # closed, nothing sent
```

The front desk runs on the `claude` CLI, or on the Anthropic API when `ANTHROPIC_API_KEY` is set. The API path has not been run against the real API yet: `ANTHROPIC_API_KEY=... ./scripts/frontdesk-api-check.sh` does that. It does not run on Codex, which cannot be started without tools ([docs/design.md](docs/design.md#decisions-and-why)).

Let your coding agent use it: `cpart setup` adds `cpart mcp` as an MCP server, and hooks that tell a session when a reply arrives. It can talk, follow a thread until it is answered, and propose, counter-propose, decline and withdraw contracts. It cannot approve one: only you can, with `cpart approve`. It cannot release a held message either. See [docs/mcp.md](docs/mcp.md).

Hold what must not leave: `cpart held`, `cpart release <id>`, `cpart drop <id>`, `cpart guard never-share add <file>`, `cpart guard repo add <path>`.

Relays: `cpart relay list`, `cpart relay add <url>`, `cpart relay move <url>`, `cpart relay remove <url>`.

Read threads, contracts and what your front desk did in a browser: `cpart view`. It only reads. Signing stays in the terminal.

## Docs

- [docs/design.md](docs/design.md): how it works and why
- [docs/protocol.md](docs/protocol.md): the wire format
- [docs/relay.md](docs/relay.md): running a relay
- [docs/pairing.md](docs/pairing.md): pairing with a short code
- [docs/connectivity.md](docs/connectivity.md): several relays, moving, reconnecting
- [docs/guard.md](docs/guard.md): the outbound guard
- [docs/front-desk.md](docs/front-desk.md): answering from your repository
- [docs/redteam.md](docs/redteam.md): trying to make a tool-using agent leak
- [docs/mcp.md](docs/mcp.md): using it from Claude Code and Codex
- [docs/verify.md](docs/verify.md): checking in CI that a repo carries what was signed
- [docs/gauntlet.md](docs/gauntlet.md): 144 attacks against it, and how each ended
- [docs/prior-art.md](docs/prior-art.md): what exists already
- [docs/verification.md](docs/verification.md): what has been tested, and what has not
