# Pairing with a short code

Two people pair once, so their daemons trust each other's keys. This is how it works with a short code like `7-cider-otter`, and why the code is enough on its own.

## Using it

```sh
cpart invite maya
```

```
Code for maya: 7-cider-otter
It works once, until 14:32. Send maya this line; they run it with the name they call you:

  cpart join 7-cider-otter@relay.example.com <your name>
```

Maya runs that line with the name she calls you. If she has no identity yet, `cpart join` creates one on that relay first, the same way `cpart setup` does. If she already uses the same relay, the bare code is enough: `cpart join 7-cider-otter sam`.

Both commands wait and print how it ended. Ctrl-C on `cpart invite` stops the waiting, not the pairing: your daemon finishes it, and `cpart status` says how it went:

```
Waiting for you:
  paired with maya by code at 14:24
```

There is no safety code to compare. The code is a shared secret, and a cryptographic protocol (below) checks that both sides used the same one, so the keys each side ends up with are the keys of whoever typed the code.

What a person sees when it goes wrong:

- A misspelt word is caught before anything is sent: `"zoomm" is not one of the code words. Check the spelling`. The code still works.
- A wrong word: Maya sees `The code did not match. Nothing was paired, and this code no longer works.` You see `Someone tried a wrong code. Nothing was paired, and this code no longer works.` Make a new code.
- Someone else used the number first: `Someone else already used this code. Nothing was paired. Ask for a new one.` On your side the code shows as a wrong guess, unless they happened to guess the words.
- Too late: `The code expired before the pairing finished.` Codes last ten minutes.

The long invite still works: `cpart invite maya --long` prints a `cpart-invite:` string, and `cpart join <that string> sam` uses it. With `--json`, `cpart invite` prints the long invite unless you add `--code`, so existing scripts keep working.

## What the code is

`7-cider-otter@relay.example.com`

- `7` is the **nameplate**: a mailbox on the relay that lives for ten minutes. It is not secret. The relay hands out short numbers when it is quiet (1 to 99, then up to 999, then 9999).
- `cider-otter` is the **password**: two words from a list of 1295. Only the two people know it. The relay never sees it.
- `@relay.example.com` says which relay to use, for someone who has no identity yet. A `wss://` address is written without its scheme; anything else (`ws://127.0.0.1:7447`) is written in full.

The words come from the [EFF short wordlist 1](https://www.eff.org/dice) by the Electronic Frontier Foundation, CC BY 3.0 US: 1296 words of 3 to 5 letters chosen to be easy to read, say and type. `yo-yo` is left out because a dash separates the words, which leaves 1295. The list is in `packages/protocol/src/wordlist.ts`, with the sha256 of the file it came from.

## How it works

The daemon does the work, over the relay connection it already holds. `cpart invite` and `cpart join` write a request into `pairing.db` in your home and wait for the daemon to write back.

```
 inviter's daemon                     relay                      joiner's daemon
 pair.open  ───────────────────────►  nameplate 7, 10 minutes
            ◄───────────────────────  pair.opened 7
 a: sid, Ya, ADa  ─────────────────►  (held)
                                      ◄──────────────────────── pair.claim 7     (once, ever)
                                      ────────────────────────► a
                                      ◄──────────────────────── b: Yb, ADb, Tb
 checks Tb
 c: Ta, box  ──────────────────────►  ────────────────────────► checks Ta, opens box
                                                                contact.request (the usual one)
 contact.accepted ◄─────────────────────────────────────────────
```

**The key exchange is CPace** ([draft-irtf-cfrg-cpace-21](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/)), the balanced PAKE the CFRG selected, with the ristretto255 group and SHA-512, in initiator-responder mode. The inviter is the initiator. Group arithmetic, the ristretto255 encoding and the element derivation come from [@noble/curves](https://github.com/paulmillr/noble-curves) 2.4.0, which has had outside audits. `packages/protocol/src/pake.ts` is the whole CPace layer, and `packages/protocol/test/pake.test.ts` checks it against every test vector the draft publishes for this suite and for its string functions (Appendix A and B.3), byte for byte, including the invalid points that must abort a run.

**What each input is:**

| CPace input | Here |
| --- | --- |
| PRS (password) | the two words, joined with a dash |
| CI (channel identifier) | `lv_cat("counterpart/pair/v1", relay URL, nameplate)` |
| sid | 16 random bytes from the inviter, sent with its first message |
| ADa, ADb | `canonical({ v: 1, role, credential })`: the sender's role and its signed device credential, which carries its root key |

So the session key (ISK) depends on the words, the relay URL both sides dialled, the nameplate, and both people's credentials. Each side checks the other's credential signature and role before using it, and refuses its own root key.

**Key confirmation, both ways** (draft section 10.4): `mac_key = SHA-512("CPaceMac" || sid || ISK)`, and each side sends `HMAC-SHA-512(mac_key, lv_cat(its share, its AD))`. The joiner sends its tag with its share. The inviter checks it before saying anything that depends on the key. The joiner checks the inviter's tag before using what comes with it.

**Then the existing machinery.** After the joiner's tag checks out, the inviter makes an ordinary invite (`cpart-invite:...`, the same credential and single-use token the long form carries), bound to the joiner's root key and valid for an hour, and sends it sealed: ChaCha20-Poly1305 under a key from HKDF-SHA-256 over the ISK. The joiner checks that the invite names the same credential and relay the code proved, then accepts it the usual way. From there it is the normal `contact.request` and `contact.accepted` ([protocol.md](protocol.md)). An invite bound to a root key is refused from any other key: `invite token was made for someone else`.

The message formats are at the top of `packages/protocol/src/pake-pairing.ts`; the relay frames are in `packages/protocol/src/relay-frames.ts`.

## Why the relay cannot cheat, and how many guesses anyone gets

The relay is not trusted. It carries every message and can drop, delay, reorder, replay, replace or invent them. What it cannot do is learn the words from what it sees, or finish a run without them:

- **No offline guessing.** CPace's messages reveal nothing that lets someone test passwords afterwards. Testing a guess means running the protocol live against one of the two people with that guess.
- **One answer per side per code.** The inviter's daemon looks at the first answer to a code and no other: right or wrong, the run is over. The joiner's daemon answers the first first-message it gets and no other, and a home never tries the same code twice (`this code was already tried here`). So whoever runs the other end, the relay included, gets at most one guess against each person.
- **Swapping anything changes the key.** Replacing a share, a credential, the sid, the relay URL or the nameplate makes the two ISKs differ, so the confirmation tags fail and both sides stop.
- **Fails closed and says so.** A wrong tag ends the run on that side, it tells the other side (`fail`), closes the nameplate, and both people get a sentence. The `fail` message is not authenticated: a relay can use it to end a pairing, which it could do anyway by dropping messages. It can never complete one.
- **Replays and reflection.** A share equal to one's own is refused (the inviter's first message sent back to it), the roles in ADa and ADb must be the right way round, and an answer from an earlier run fails because the sid and shares differ.

The relay's own rules only make abuse slower: a nameplate can be claimed once, ever; it lasts ten minutes; a number rests for thirty minutes after it closes, so an old code never reaches a new pairing; a device may open 10 and claim 10 nameplates an hour, with 3 open at once; a side may send 4 messages per nameplate, of at most 4096 characters.

### Entropy

Two words from 1295 give 1295² = 1,677,025 equally likely passwords, about 20.7 bits. The nameplate number adds nothing secret.

- Someone who is not the relay can only play the joiner, and must claim the number before the real joiner does. One guess: a chance of 1 in 1,677,025. A wrong guess ends the code and both people are told.
- The relay can play both ends: one guess against the inviter, one against the joiner. A chance of at most 2 in 1,677,025, about 1 in 840,000 per code, and every wrong guess shows up as a failed pairing on someone's screen.
- Scanning many codes does not add up quietly: each guess burns a real person's code, which they see.

That is enough for something used a few times by people who are talking to each other at the time. It is not enough for a code left lying about for days, which is why codes expire in ten minutes. Three words would give 31 bits; we judged the extra word not worth it for a code read aloud.

## Limits

- **The relay URL is part of the key.** Both people must dial the relay by the same address, because the relay URL goes into CI and because an identity is tied to its relay's address anyway ([verification.md](verification.md#known-limits)). A Mac and a dev container on that Mac cannot both use `ws://127.0.0.1:7447`: inside the container that address is the container. Use an address both can reach under one name, such as `cpart relay --tunnel`.
- **Nameplates live in the relay's memory.** A relay restart ends every pairing in progress. Make a new code.
- **A daemon restart in the middle of a run ends it.** The secrets of a run are kept in memory only; after a restart the daemon marks it failed and says why. A dropped relay connection does not: after reconnecting, the daemon sends its last pairing messages again, and the relay treats a repeat as one message.
- **The words sit in `pairing.db`** in your home (mode 600, in a 700 directory) while a pairing is live, so the CLI can show the code and the daemon can run it. They are wiped when it ends.
- **A short code needs a daemon.** If none is running and none can be started, `cpart invite` says so and prints the long invite.
- **An old relay** that does not know nameplates closes the connection on the first `pair.*` frame. The daemon gives up after three tries and suggests `--long`.
- The `fail` message, `pair.closed` and relay errors are unauthenticated. They can end a pairing, never complete one.

## Checks

- `pnpm test`: the CPace vectors (`packages/protocol/test/pake.test.ts`), the pairing messages (`pairing.test.ts`), the relay's nameplates (`packages/relay/test/nameplates.test.ts`), two daemons pairing in process (`packages/daemon/test/pairing.test.ts`), and gauntlet cases PAIR-01 to PAIR-11 (`packages/gauntlet/src/cases/pairing.ts`): a wrong word, a squatter's guess, a replayed answer, a reflected message, a relay swapping a credential, a relay sending many guesses or a second first message, reuse of a nameplate, scanning numbers, a code-made invite used by someone else, and a message lost with a dropped connection.
- `./scripts/pairing-smoke.sh`: a relay, daemons and the CLI as real processes. A joiner with no identity, a typo, a wrong word, the right code after a wrong one, a bare code, an invite waiting in the foreground, and the long invite. It ends with `PAIRING SMOKE OK`.
