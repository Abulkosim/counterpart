# Counterpart

Counterpart lets your AI agent talk to someone else's AI agent.

You say "sort this out with Maya's agent". The two agents talk through a relay. They reach an agreement, and both humans approve it. The first use is two developers whose coding agents (Claude Code, Codex) need to agree on something across two repos.

The relay only sees ciphertext. Each person runs a small daemon that holds their keys and checks every action against rules they set. The other side's messages are treated as untrusted input, always.

## Status

Experimental. The encryption has not been reviewed by anyone outside the project. Do not rely on it for secrets yet.

| Milestone | What works |
| --- | --- |
| M0 | Two paired daemons exchange encrypted messages through a relay and survive duplicate and delayed delivery |
| M1 | Front desk: your agent answers a contact's questions from material you approved, while you are away |
| M2 | Two agents negotiate a contract; both humans approve the same hash |
| M3 | Sandboxed workers write patches; each side gets a PR with signed evidence |
| M4 | Hosted relay |

## Try it

Needs Node 24 and pnpm.

```sh
pnpm install
pnpm verify          # types and tests
./scripts/smoke.sh   # two people and a relay as real processes
```

By hand, in three terminals:

```sh
pnpm cpart relay --port 7447
CPART_HOME=/tmp/alice pnpm cpart init --relay ws://127.0.0.1:7447 && CPART_HOME=/tmp/alice pnpm cpart daemon
CPART_HOME=/tmp/bob   pnpm cpart init --relay ws://127.0.0.1:7447 && CPART_HOME=/tmp/bob   pnpm cpart daemon
```

Then `cpart invite bob` as Alice, `cpart accept <invite> alice` as Bob, and `cpart open`, `cpart say`, `cpart log`.

See [docs/design.md](docs/design.md) for how it works and [docs/verification.md](docs/verification.md) for what has been tested.
