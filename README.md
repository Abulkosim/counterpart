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
| M2 | Two agents negotiate a contract; both humans approve the same hash | Contracts and signed agreements done; agent tools and notifications next |
| M3 | Workers write patches; each side gets a PR with signed evidence | Worker and repo verifier done; PRs and evidence next |
| M4 | Hosted relay | |

## Try it

Needs Node 24 and pnpm.

```sh
pnpm install
pnpm verify              # types and tests
./scripts/smoke.sh       # two people and a relay as real processes
./scripts/contract-smoke.sh # two people sign an agreement and verify it
./scripts/demo-work.sh       # after an agreement, a worker proposes the patch. Uses real models
./scripts/demo-agents.sh   # Bob's Claude Code session asks Alice's front desk. Uses real models
```

By hand, in three terminals:

```sh
pnpm cpart relay --port 7447
CPART_HOME=/tmp/alice pnpm cpart init --relay ws://127.0.0.1:7447 && CPART_HOME=/tmp/alice pnpm cpart daemon
CPART_HOME=/tmp/bob   pnpm cpart init --relay ws://127.0.0.1:7447 && CPART_HOME=/tmp/bob   pnpm cpart daemon
```

Pair: `cpart invite bob` as Alice, `cpart accept <invite> alice` as Bob. Compare the safety code out of band.

Talk: `cpart open alice "goal"`, `cpart say <thread> "text"`, `cpart log <thread>`.

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
cpart work apply <work-id> <patch-hash>  # writes the files, commits nothing
```

Let your agent answer for you while you are away:

```sh
cpart bundle add bob docs/api.md      # everything the front desk may tell bob
cpart desk on bob --as Alice --slots 6
```

Let your coding agent use it: add `cpart mcp` as an MCP server. See [docs/mcp.md](docs/mcp.md).

Read threads in a browser: `cpart view`.

## Docs

- [docs/design.md](docs/design.md): how it works and why
- [docs/protocol.md](docs/protocol.md): the wire format
- [docs/mcp.md](docs/mcp.md): using it from Claude Code and Codex
- [docs/verify.md](docs/verify.md): checking in CI that a repo carries what was signed
- [docs/gauntlet.md](docs/gauntlet.md): 99 attacks against it, and how each ended
- [docs/prior-art.md](docs/prior-art.md): what exists already
- [docs/verification.md](docs/verification.md): what has been tested, and what has not
