---
name: verify
description: Exercise Counterpart for real after a change (two people, a relay process, daemons, the CLI) and read what each side actually sees. Use before opening or merging any PR that changes behaviour, and whenever a test passes but you have not watched the thing work.
---

# Verify by running it

Tests passing is not the bar. The bar is that you ran the real programs and read the output.

## Always

1. `pnpm verify` — types and tests.
2. `./scripts/smoke.sh` — starts a relay and two daemons as separate processes, pairs them, talks both ways, takes one side offline, restarts the relay, sends a message with terminal escape codes, then prints both logs. It must end with `SMOKE OK`.
3. `./scripts/contract-smoke.sh` — two people propose, revise, sign and export an agreement through the CLI. It must end with `CONTRACT SMOKE OK`. For approvals, set `CPART_PASSPHRASE` and pass `--yes`; to test the prompts themselves, drive the CLI through a pseudo-terminal.
4. `./scripts/resend-smoke.sh` — deletes a queued message from the relay's database while the recipient is offline, shows the next message held, then recovered by a resend. It must end with `RESEND SMOKE OK`.
5. `./scripts/evidence-smoke.sh` — one of them ties a local Git repository to the agreement and sends evidence; the other sees the part checked, then a mismatch after one byte changes. It must end with `EVIDENCE SMOKE OK`.
6. Read the printed logs yourself. Check they match, are in the order the messages were sent, and that the hostile line shows as escaped text.

## When you changed something specific

Drive it by hand the way a person would. Two identities live in separate `CPART_HOME` directories:

```sh
W=$(mktemp -d)
node packages/cli/src/main.ts relay --port 7462 --db $W/relay.db &
CPART_HOME=$W/a node packages/cli/src/main.ts init --relay ws://127.0.0.1:7462 --no-passphrase
CPART_HOME=$W/b node packages/cli/src/main.ts init --relay ws://127.0.0.1:7462 --no-passphrase
CPART_HOME=$W/a node packages/cli/src/main.ts daemon &
CPART_HOME=$W/b node packages/cli/src/main.ts daemon &
```

Then use `invite`, `accept`, `open`, `say`, `log`, `rejects`. Add `--json` to parse output.

- Changed what a peer can send or how it is checked: send the bad input from a real second identity and confirm it shows up in `cpart rejects` with a reason a person can understand, and that nothing else changed.
- Changed delivery or storage: kill a process mid-flow (`kill -9`), restart it, and confirm nothing is lost or applied twice.
- Changed anything a person reads (CLI text, the viewer): look at it. For web pages, open them in the browser and take a screenshot; check an empty state, a long thread, and hostile text.
- Changed anything that calls a model: run it against the real model at least once and read the full transcript. Then run the hostile-peer suite.

## Then

- Fix what you found and run it again. Do not report success from a run that predates your last edit.
- Add one line to `docs/verification.md`: date, what you ran, what you saw, what you did not check.
- If you could not run something (no second machine, no macOS), say so there. Do not imply it was tested.
