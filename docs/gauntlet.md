# Gauntlet

Counterpart says its security comes from code that limits what can happen, not from asking a model to behave. This is the test of that. Each case below is an attack run against the real code: the protocol library, the relay, the daemon and the `cpart` CLI. The attacker is a stranger, one of your contacts, the relay, or someone on the network.

A case states one rule and tries to break it. "Held" means the attack was refused and the test confirmed nothing else changed. "Open finding" means the attack worked and the defect is not fixed yet. Open findings stay in the suite and are listed first, with the attack and a suggested fix.

This file is generated. Run `pnpm gauntlet` to rebuild it. The same cases run in `pnpm test` on every commit. The cases live in `packages/gauntlet/src/cases`.

## Totals

| Category | Cases | Held | Open findings | Failed |
| --- | ---: | ---: | ---: | ---: |
| Envelope and identity | 20 | 18 | 2 | 0 |
| Canonical form and parsing | 11 | 9 | 2 | 0 |
| Replay and ordering | 13 | 13 | 0 | 0 |
| Authority | 20 | 14 | 6 | 0 |
| The relay as attacker | 10 | 10 | 0 | 0 |
| Clients attacking the relay | 14 | 11 | 3 | 0 |
| Terminal output | 7 | 2 | 5 | 0 |
| Local storage | 4 | 2 | 2 | 0 |
| **All** | **99** | **79** | **20** | **0** |

## Open findings

Most severe first. Each is demonstrated by the case with the same id in the tables below.

### ENV-20: Send a contact request with an unusable encryption key (high)

- **Rule that should hold:** A message that cannot be answered is refused and recorded like any other bad message.
- **Who can do it:** stranger
- **What is wrong:** a credential with a small-order X25519 key makes receive() throw instead of refusing.
- **Attack:** Anyone who has seen Bob's credential (a contact, anyone who was ever shown an invite, the relay) seals a contact.request whose own credential has encKey set to 32 zero bytes. The daemon builds the acceptance before it checks the invite token, HPKE refuses the key, and receive() throws. RelayLink treats that as its own failure: it drops the connection without acknowledging, the relay delivers the same message again, and the loop never ends. See AUT-17 for the effect on other mail.
- **Where:** `packages/daemon/src/node.ts:333 (and packages/protocol/src/identity.ts:55, packages/daemon/src/link.ts:151)`
- **Suggested fix:** Reject credentials whose encKey is a small-order point in verifyCredential. Check the invite token before building the acceptance, and turn a failed seal into a Reject. In RelayLink, acknowledge and record a message that has failed locally more than a few times.

### AUT-17: Block a contact's mail from outside (high)

- **Rule that should hold:** Someone who is not a contact cannot stop a contact's messages from being delivered and applied.
- **Who can do it:** stranger
- **What is wrong:** messages that make receive() throw are redelivered forever and fill the relay's delivery window.
- **Attack:** Eve logs in to the relay with a throwaway identity and sends Bob one delivery window of the messages from ENV-20 (100 by default, well inside the 500 a sender may queue). Bob's daemon throws on each, drops the connection without acknowledging and reconnects. The relay sends the same window again, and waits for it to be acknowledged before sending anything newer. Mail from Bob's real contacts is stored but never delivered, for as long as Eve keeps the window full. Bob's daemon reconnects about four times a second meanwhile.
- **Where:** `packages/daemon/src/link.ts:151`
- **Suggested fix:** Fix ENV-20 and AUT-11. Independently, count local failures per message id in RelayLink and acknowledge and record a message after a few attempts, so no single message can hold the mailbox.

### AUT-10: File a contact event inside someone else's thread (medium)

- **Rule that should hold:** Contact events never appear in a thread's log, and one contact cannot touch a thread it is not part of.
- **Who can do it:** contact
- **What is wrong:** contact.hello is stored under whatever thread id the sender chose.
- **Attack:** Mallory, a contact of Bob, learns the id of a thread between Bob and Alice (ids are printed by the CLI and are not treated as secret). She sends contact.hello with that thread id. Bob's daemon applies it and stores it in that thread. `cpart log` shows a line attributed to alice that Alice never sent, the thread's event count changes, and Bob's next message lists Mallory's event as a parent. Alice never receives that parent, so she holds every later message from Bob in that thread forever. A contact.request does the same through the acceptance Bob writes into the chosen thread.
- **Where:** `packages/daemon/src/node.ts:384`
- **Suggested fix:** Ignore the thread id on contact.* events and store them under a reserved per-contact id, or refuse a contact event whose thread id is a known thread. Make log() and heads() select on the thread's participants, not only its id.

### AUT-11: Answer an invite inside an existing thread (medium)

- **Rule that should hold:** A contact request is accepted or refused cleanly whatever thread id it names, and leaves existing threads alone.
- **Who can do it:** contact
- **What is wrong:** the acceptance is written into the requester's chosen thread and collides with Bob's own event 0, so receive() throws.
- **Attack:** Mallory is a contact and has a thread that Bob opened. Bob issues another invite, to her second identity or to someone whose invite she can read. She answers it with a contact.request whose thread id is that existing thread. Bob's daemon tries to write its contact.accepted as its own event 0 in that thread, the unique index refuses, and receive() throws. The message is never acknowledged, so the relay delivers it again on every reconnect and the daemon loops, as in ENV-20. The invite is never marked used.
- **Where:** `packages/daemon/src/node.ts:333 and :360`
- **Suggested fix:** Write the acceptance under a fresh thread id chosen by the acceptor. Treat any failure to commit an inbound message as a Reject.

### AUT-20: Show up in another thread before pairing completes (medium)

- **Rule that should hold:** Events held for a contact whose pairing is not complete are not listed in any thread.
- **Who can do it:** contact
- **What is wrong:** events from a pending contact are held without any check and stored under the thread id they name, and log() returns them.
- **Attack:** Bob accepts Mallory's invite. Before she confirms, she sends talk.posted naming a thread between Bob and Alice whose id she has learned. The daemon holds it unchecked. `cpart log` for that thread prints her text on a line that starts with alice, marked only "(held)", which is also how a real message from Alice that is waiting for a parent looks. It stays there for as long as Mallory withholds her acceptance. Same root cause as AUT-10.
- **Where:** `packages/daemon/src/node.ts:383 and packages/cli/src/main.ts:110`
- **Suggested fix:** Make log() return only events whose author is a participant of the thread, and show held events from a pending contact nowhere.

### RC-06: Fill a mailbox with throwaway identities (medium)

- **Rule that should hold:** Strangers cannot use up a mailbox so that mail from the owner's contacts is turned away.
- **Who can do it:** stranger
- **What is wrong:** the per-mailbox cap is shared by every sender, and a new sender identity costs nothing on an open relay.
- **Attack:** Bob is offline. Eve generates ten identities and queues 500 messages for Bob from each, which is the per-sender limit. Bob's mailbox is at its 5000 cap. Alice's messages to Bob now get mailbox_full until Bob comes back and works through Eve's junk, and Eve can refill it. A hundred identities fill the whole relay the same way.
- **Where:** `packages/relay/src/index.ts:174`
- **Suggested fix:** Split each mailbox: let a device give the relay the device ids it accepts mail from, and give everyone else a small separate allowance. On a public relay also limit logins per address, or run invite-only (allowRoots).

### RC-11: Hold open connections that never log in (medium)

- **Rule that should hold:** The relay limits how many connections can sit unauthenticated at once.
- **Who can do it:** stranger
- **What is wrong:** there is no cap on unauthenticated sockets, only a ten second timer on each.
- **Attack:** Eve opens connections and sends nothing. Each is held for ten seconds, then up to thirty more while the close handshake times out, and she reopens them as they drop. Nothing bounds the number per address or in total, so one machine can hold tens of thousands of sockets and their timers open, until the relay runs out of file descriptors and real clients cannot connect.
- **Where:** `packages/relay/src/index.ts:117`
- **Suggested fix:** Cap unauthenticated connections in total and per remote address, refuse the upgrade past the cap, and terminate (not close) on the auth timeout.

### OUT-03: Reorder or hide text with Unicode formatting characters (medium)

- **Rule that should hold:** Bidirectional overrides, isolates, zero-width characters and Unicode line separators in peer text are shown escaped.
- **Who can do it:** contact
- **What is wrong:** the CLI prints U+202E, U+2066 to U+2069, zero-width characters and U+2028 as they are.
- **Attack:** Mallory sends "I do not agree \u202E..." or wraps part of a message in an override so that, on a terminal that applies the bidi algorithm, the line Bob reads says something other than the bytes that were signed. Zero-width characters let her make two different texts look the same, and U+2028 breaks the line on terminals that honour it, which lets her start a fake log line. Bob or his agent then acts on what the screen shows.
- **Where:** `packages/cli/src/main.ts:39`
- **Suggested fix:** Escape the Unicode Cf category (at least U+061C, U+200B to U+200F, U+202A to U+202E, U+2060 to U+2069, U+FEFF) and U+2028/U+2029 in everything a peer wrote.

### OUT-04: Get escape codes into the list of refused messages (medium)

- **Rule that should hold:** The reason shown for a refused message contains nothing the sender wrote.
- **Who can do it:** contact
- **What is wrong:** a JSON syntax error quotes the start of the sender's payload, and that text is stored and printed raw.
- **Attack:** Anyone who knows Bob's encryption key (a contact, anyone who saw an invite, the relay) seals a payload that is not JSON and starts with ESC [ 2 J or another short sequence. JSON.parse reports `Unexpected token ..., "<first ten characters>"... is not valid JSON`, the daemon stores that as the reason, and `cpart rejects` and the daemon's own output print it. About ten characters of the attacker's choice run in Bob's terminal, enough to clear the screen or hide what follows.
- **Where:** `packages/daemon/src/node.ts:325 and packages/cli/src/main.ts:118`
- **Suggested fix:** Map errors from open() to a fixed set of reasons before storing them, and pass every stored reason through the same escaping as message text when printing.

### STO-02: Read the message log as another local user (medium)

- **Rule that should hold:** Nothing in the identity directory is readable by other users, whatever the directory's own permissions were.
- **Who can do it:** stranger
- **What is wrong:** state.db is created with the process umask, and an existing home directory is not tightened.
- **Attack:** CPART_HOME points at a directory that already exists with ordinary permissions (made by hand, by a provisioning script, or a shared path). `cpart init` writes keys.json as 0600 but SQLite creates state.db, and later its -wal file, as 0644. Any other user on the machine can read every message, contact, credential and unused invite token in plaintext. With a readable invite token they can also pair as the invited person.
- **Where:** `packages/daemon/src/node.ts:77 and :115`
- **Suggested fix:** At init and open, chmod the home directory to 0700 or refuse to run if group or others can read it. Create state.db with mode 0600 before SQLite opens it.

### ENV-07: Claim another person's device as your own (low)

- **Rule that should hold:** An event signed by a device is tied to the one person whose root key vouched for it when it was signed.
- **Who can do it:** contact
- **What is wrong:** the event signature does not cover the credential, so any root key can adopt a signed event.
- **Attack:** Mallory issues a credential from her own root key for Alice's device keys, which are public. Anyone holding an event Alice signed can swap the credential and it opens as Mallory's. Bob then files Alice's contact.hello under Mallory and replaces Mallory's stored credential, so his next messages to Mallory are encrypted and addressed to Alice's device. There is no working attack today because only the recipient holds the plaintext. It becomes one when signed events are shown to third parties as evidence (M3).
- **Where:** `packages/protocol/src/envelope.ts:52`
- **Suggested fix:** Sign canonical({ header, event, rootKey }) or a hash of the credential, and verify the same.

### PAR-01: Prefix signed bytes with a byte order mark (low)

- **Rule that should hold:** Input that is not byte for byte canonical is refused.
- **Who can do it:** contact
- **What is wrong:** parseCanonical strips a leading UTF-8 BOM before comparing, so two byte strings pass as canonical.
- **Attack:** A sender puts EF BB BF in front of the sealed payload, or in front of an invite. TextDecoder drops it, the text that is left equals its canonical form, and the input is accepted. Nothing is forged today because signatures are checked over re-encoded values, but the rule that there is one encoding per value does not hold, and anything that later hashes received bytes will disagree with a strict peer.
- **Where:** `packages/protocol/src/canonical.ts:38`
- **Suggested fix:** Decode with new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }) so the BOM stays in the text and fails the comparison.

### PAR-11: Respell base64 without changing the bytes (low)

- **Rule that should hold:** Keys, signatures and ciphertext have one accepted spelling each.
- **Who can do it:** relay
- **What is wrong:** unb64u ignores the unused trailing bits, so a 43-character key has 4 spellings and an 86-character signature has 16.
- **Attack:** A relay changes the last character of `enc` (or a sender the last character of `sig`, or a root key holder the spelling of a key in a credential) to another character that decodes to the same bytes. The message still opens and verifies. The same event now exists as several different wires and signatures, a root key has four names in the contacts table, and a relay allow-list or any future hash over signatures or wire bytes can be sidestepped or made to disagree.
- **Where:** `packages/protocol/src/bytes.ts:6`
- **Suggested fix:** In unb64u, re-encode the decoded bytes and require the result to equal the input.

### AUT-16: Break credential renewal for other contacts (low)

- **Rule that should hold:** One contact cannot stop the daemon from telling its other contacts about a renewed credential.
- **Who can do it:** contact
- **What is wrong:** a contact's credential with an unusable encKey makes renewIfDue() throw part-way, after the new credential is saved.
- **Attack:** Mallory, a contact, sends contact.hello with a credential from her root key whose encKey is 32 zero bytes. Bob stores it as her newest credential. When Bob's credential is next due, renewIfDue() saves the new credential, then fails to seal the hello for Mallory and throws. Contacts sorted after her never get a hello, and later calls see nothing to renew. Sixty days on, those contacts hold an expired credential for Bob and cannot write to him until he writes to them. Bob also can no longer open a thread with Mallory, which only hurts her.
- **Where:** `packages/daemon/src/node.ts:139`
- **Suggested fix:** Refuse credentials with a small-order encKey (see ENV-20). Queue each hello independently, and track which contacts have been told so a failed one is retried.

### AUT-18: Flush the record of refused messages (low)

- **Rule that should hold:** Everything refused is recorded, and a stranger cannot erase the record of what a contact tried.
- **Who can do it:** stranger
- **What is wrong:** the reject log keeps the newest 1000 rows from any source, so 1000 junk messages push out everything older.
- **Attack:** Mallory, a contact, sends Bob two different events with one sequence number. The second is refused and recorded, which is Bob's only evidence of it. Anyone with a relay login then sends Bob 1000 malformed messages. Each costs the sender nothing to make and adds a reject row. The row about Mallory is deleted.
- **Where:** `packages/daemon/src/node.ts:475`
- **Suggested fix:** Keep separate, separately capped logs for messages that failed to open and for refusals of events from known contacts, or cap per sender root key.

### RC-14: Reset the rate limit by reconnecting (low)

- **Rule that should hold:** The frame rate limit applies to a device, not to one connection.
- **Who can do it:** stranger
- **What is wrong:** each new connection starts with a full allowance, so logging in again resets the limit.
- **Attack:** Eve sends her burst of 100 frames, logs in again on a new socket, and sends another 100. Logging in costs one signature. She can keep the relay parsing, hashing and querying at many times the intended 50 frames a second from a single identity, and a few identities multiply it.
- **Where:** `packages/relay/src/index.ts:118`
- **Suggested fix:** Keep the token bucket per device id across connections, and add a second bucket per remote address that also covers failed logins.

### OUT-02: Use DEL and 8-bit control characters (low)

- **Rule that should hold:** C1 control characters (U+0080 to U+009F) and DEL are escaped like the 7-bit ones.
- **Who can do it:** contact
- **What is wrong:** the CLI escapes with JSON.stringify, which leaves U+007F to U+009F as they are.
- **Attack:** Mallory sends a message containing U+009B, the one-character form of ESC [. On a terminal that honours C1 controls (xterm and some others when so configured), `cpart log` and `cpart threads` then run her sequences: clear the screen, move the cursor, recolour or hide text, set the title. Most modern UTF-8 terminals ignore C1, which is why this is low.
- **Where:** `packages/cli/src/main.ts:39`
- **Suggested fix:** Escape by code point: everything in U+0000 to U+001F and U+007F to U+009F as \uXXXX.

### OUT-05: Write to the daemon's terminal from the relay (low)

- **Rule that should hold:** Nothing the relay sends is printed by the daemon without escaping.
- **Who can do it:** relay
- **What is wrong:** the relay's error code is printed raw in `error: relay refused the login: ...`.
- **Attack:** A hostile or compromised relay answers the login with { t: "error", code: "<ESC>[2J<ESC>[1;1Hconnected to ..." }. The daemon prints up to 64 characters of it to stderr. The relay can clear the terminal the daemon runs in and write a fake status line.
- **Where:** `packages/daemon/src/link.ts:130 and packages/cli/src/main.ts:66`
- **Suggested fix:** Accept only codes matching /^[a-z_]{1,32}$/ and show anything else as "unknown".

### OUT-07: Backdate a message (low)

- **Rule that should hold:** The time shown beside a peer's message is the time it arrived, or is marked as the sender's claim.
- **Who can do it:** contact
- **What is wrong:** `cpart log` prints the sender's createdAt as the time of the message, with no limit on how old it may be.
- **Attack:** Mallory sends today a message whose createdAt is two years ago: "as agreed, the deadline is the 1st". Only future dates are refused. Bob's log shows it with the old date, in the same format as every other line. A person or an agent reading the log later takes it as evidence that the statement was made then.
- **Where:** `packages/cli/src/main.ts:112`
- **Suggested fix:** Print receivedAt, or print both when they differ by more than the allowed clock skew.

### STO-04: Read who writes to whom from the relay's disk (low)

- **Rule that should hold:** The relay stores who a message is for and when it expires, and nothing else about it.
- **Who can do it:** relay
- **What is wrong:** each queued message is stored with its sender's device id.
- **Attack:** Someone who obtains the relay's database (a backup, a seized disk, a curious operator) reads the from_device and to_device columns and learns which devices were writing to which while messages were queued. docs/design.md says the relay sees who a message is for and when it expires, and nothing else. The relay has to know the sender while it is connected, but nothing requires writing it down in the clear.
- **Where:** `packages/relay/src/index.ts:68`
- **Suggested fix:** Store a keyed hash of the sender (key held in memory, new on each start) for the quota counts, or say in the docs that the relay records sender and recipient for queued mail.

## Code-enforced rules

These are guarantees. A case here either holds or it does not.

### Envelope and identity

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| ENV-01 Rewrite the routing header in transit | relay | A message whose header was changed after sealing is refused. | held |
| ENV-02 Change, cut or splice the ciphertext | relay | Any change to the encrypted bytes or the encapsulated key is refused. | held |
| ENV-03 Forward someone's signed event to a third device | contact | An event signed for one recipient cannot be passed to another as if it were sent to them. | held |
| ENV-04 Name another device as the author | contact | The author of an event must be the device whose credential and signature come with it. | held |
| ENV-05 Attach a contact's credential and sign with another key | contact | A credential is only as good as a signature from the device key inside it. | held |
| ENV-06 Issue yourself a credential under someone else's root key | contact | A credential counts only if the root key it names signed it. | held |
| ENV-07 Claim another person's device as your own | contact | An event signed by a device is tied to the one person whose root key vouched for it when it was signed. | **open finding** |
| ENV-08 Sign one header and send another | contact | The signature must cover the exact header the message arrives with. | held |
| ENV-09 Show the relay one id and the recipient another | contact | The id on the outside of a message must be the id of the event inside. | held |
| ENV-10 Replay a login signature as an event signature | relay | A signature a device gave the relay to log in cannot be used to sign an event. | held |
| ENV-11 Replay an event signature as a relay login | contact | A signature on an event cannot be used to log in to the relay as its author. | held |
| ENV-12 Replay a credential signature as an event signature | contact | A root key's signature on a credential cannot be used to sign an event. | held |
| ENV-13 Edit a credential without the root key | contact | Changing any field of a credential invalidates it. | held |
| ENV-14 Use a credential at and after its expiry | contact | A credential stops working at the millisecond it expires, and not before. | held |
| ENV-15 Date a credential in the future | contact | A credential issued more than five minutes ahead of the receiver's clock is refused. | held |
| ENV-16 Hold a message back until after it expires | relay | A message delivered at or after its expiry is refused. | held |
| ENV-17 Add to or cut from the sealed payload | contact | The sealed payload holds an event, a signature and a credential, and nothing else. | held |
| ENV-18 Deliver an old message to roll a credential back | relay | A contact's stored credential only moves forward, whatever order messages arrive in. | held |
| ENV-19 Date an event in the future | contact | An event dated more than ten minutes ahead of the receiver's clock is refused. | held |
| ENV-20 Send a contact request with an unusable encryption key | stranger | A message that cannot be answered is refused and recorded like any other bad message. | **open finding** |

### Canonical form and parsing

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| PAR-01 Prefix signed bytes with a byte order mark | contact | Input that is not byte for byte canonical is refused. | **open finding** |
| PAR-02 Repeat a JSON key with two different values | contact | A payload with a duplicate key is refused, so no two readers can pick different values. | held |
| PAR-03 Spell the same payload another way | contact | Only the canonical spelling of a payload is accepted: no spare whitespace, reordered keys, optional escapes or alternative number forms. | held |
| PAR-04 Use fractions, negatives and oversized numbers | contact | Every number is a non-negative safe integer, or the message is refused. | held |
| PAR-05 Send text that is not well-formed Unicode | contact | Unpaired surrogates and invalid UTF-8 are refused, not repaired. | held |
| PAR-06 Smuggle __proto__ and constructor keys | contact | Keys that name JavaScript internals are treated as unknown fields and refused, and nothing leaks into shared prototypes. | held |
| PAR-07 Invent event types and cross lanes | contact | Only the listed event types are accepted, each in its own lane. | held |
| PAR-08 Go one past every size limit | contact | Over-limit text, goals, parent lists and identifiers are refused whole, never truncated. | held |
| PAR-09 Exhaust the parser with depth and size | contact | Deeply nested or very large payloads are refused quickly and the daemon keeps working. | held |
| PAR-10 Hand over a hostile invite | stranger | A malformed, oversized or tampered invite is refused before anything is stored or sent. | held |
| PAR-11 Respell base64 without changing the bytes | relay | Keys, signatures and ciphertext have one accepted spelling each. | **open finding** |

### Replay and ordering

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| RPL-01 Seal the same event again in fresh envelopes | contact | An event takes effect once, however many different envelopes carry it. | held |
| RPL-02 Reuse an event id for different words | contact | Once an event id is recorded, its content cannot be replaced. | held |
| RPL-03 Take over the id of someone else's event | contact | A contact cannot replace or shadow an event written by Bob or by another contact, even knowing its id. | held |
| RPL-04 Issue two events with one sequence number | contact | A device gets one event per sequence number in a thread, including events that are still held. | held |
| RPL-05 Write into a thread that does not exist | contact | Events for an unknown thread are held out of sight and never create the thread. | held |
| RPL-06 Cite parents that never arrive | contact | An event is applied only after every parent it names has been applied in the same thread. | held |
| RPL-07 Build a cycle of parents | contact | Events that depend on themselves or on each other are never applied. | held |
| RPL-08 Cite a parent from another thread | contact | A parent must be an applied event of the same thread. | held |
| RPL-09 Flood the daemon with events it must hold | contact | At most 200 events are held per contact, and one contact's flood does not take room from another. | held |
| RPL-10 Deliver a long chain backwards | relay | Held events are released in an order that respects their parents, whatever order they arrived in. | held |
| RPL-11 Park an event in a thread someone else will open | contact | A held event is checked again when its thread appears, and dropped if its sender does not belong there. | held |
| RPL-12 Queue bad events behind a pending pairing | contact | Events held while a pairing is pending are invisible, and each is checked in full when the pairing completes. | held |
| RPL-13 Replay a captured message through another relay account | network | Ciphertext captured on the wire and sent again by anyone is applied at most once. | held |

### Authority

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| AUT-01 Send every kind of event without being a contact | stranger | Nothing from a root key that is not a contact takes effect or is held. | held |
| AUT-02 Guess pairing tokens | stranger | Wrong tokens admit nobody and do not use up the real invite. | held |
| AUT-03 Use an intercepted invite, before or after its owner | stranger | An invite admits exactly one identity. Later uses are refused, and their senders stay strangers. | held |
| AUT-04 Use an invite after it expires | stranger | An invite stops working at its expiry time. | held |
| AUT-05 Change the name you are filed under | contact | A contact's name is chosen locally and nothing the contact sends can change it or add a second one. | held |
| AUT-06 Write into a thread between two other people | contact | Only the two participants of a thread can add to it. | held |
| AUT-07 Open a thread that names a third party, or too few parties | contact | A thread's participants are exactly the sender and the receiver. | held |
| AUT-08 Open a thread id that already exists | contact | A thread is opened once. Its goal and its participants never change after that. | held |
| AUT-09 Open a thread with history already attached | contact | thread.opened is its author's event 0 and has no parents. | held |
| AUT-10 File a contact event inside someone else's thread | contact | Contact events never appear in a thread's log, and one contact cannot touch a thread it is not part of. | **open finding** |
| AUT-11 Answer an invite inside an existing thread | contact | A contact request is accepted or refused cleanly whatever thread id it names, and leaves existing threads alone. | **open finding** |
| AUT-12 Send pairing events after pairing is done | contact | contact.request and contact.accepted from an established contact are refused and change nothing. | held |
| AUT-13 Complete someone else's pending pairing | contact | Only the person whose invite was accepted can complete that pairing. | held |
| AUT-14 Send before your side of the pairing is confirmed | contact | Until the acceptance arrives, nothing the other side sends is visible or acted on. | held |
| AUT-15 Make the daemon send something | contact | No message from a peer makes the daemon send anything, except the reply to a valid invite. | held |
| AUT-16 Break credential renewal for other contacts | contact | One contact cannot stop the daemon from telling its other contacts about a renewed credential. | **open finding** |
| AUT-17 Block a contact's mail from outside | stranger | Someone who is not a contact cannot stop a contact's messages from being delivered and applied. | **open finding** |
| AUT-18 Flush the record of refused messages | stranger | Everything refused is recorded, and a stranger cannot erase the record of what a contact tried. | **open finding** |
| AUT-19 Sit in the middle of a pairing | network | Someone who swaps the invite on its way becomes the contact on both sides, and the two safety codes no longer match. | held |
| AUT-20 Show up in another thread before pairing completes | contact | Events held for a contact whose pairing is not complete are not listed in any thread. | **open finding** |

### The relay as attacker

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| HR-01 Send frames that are not frames | relay | Garbage from the relay is ignored or refused, and the daemon keeps its connection and its state. | held |
| HR-02 Send one enormous frame | relay | A frame over the size limit is dropped unread and the daemon reconnects with its state intact. | held |
| HR-03 Send a compression bomb | relay | A small compressed frame that inflates past the size limit is cut off, not buffered. | held |
| HR-04 Flood the daemon with deliveries | relay | A burst of deliveries is bounded in memory and on disk, changes nothing, and does not stop real mail. | held |
| HR-05 Forge stored and error frames | relay | Receipts from the relay only ever touch the outbox entry they name. They cannot alter received events, and a full mailbox is retried. | held |
| HR-06 Accept the login and never say ready | relay | Nothing leaves the outbox until the relay has confirmed the login, and the daemon does not spin. | held |
| HR-07 Forward another relay's challenge | relay | A login made at one relay cannot be used at another, even when the first relay forwards the second one's challenge. | held |
| HR-08 Deliver mail meant for someone else, and reflect mail back | relay | The daemon only opens messages sealed to its own device, and never accepts its own messages back. | held |
| HR-09 Duplicate and reorder a conversation | relay | Whatever order and however many times the relay delivers, each event is applied once, after its parents. | held |
| HR-10 Drop one message from the middle | relay | When the relay drops a message, later ones that depend on it are held and never shown as if nothing were missing. | held |

### Clients attacking the relay

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| RC-01 Use the relay without logging in | stranger | Before a valid login the relay accepts nothing but a login. | held |
| RC-02 Replay a captured login | network | A login is bound to one connection's challenge and cannot be replayed on another. | held |
| RC-03 Knock a device offline | stranger | Only a login with the device's own key replaces its connection. | held |
| RC-04 Read or delete someone else's mail | stranger | Mail is delivered only to the device it is addressed to, and only that device can acknowledge it away. | held |
| RC-05 Get around the per-sender quota | contact | One device cannot queue more than its share, by reconnecting, by spraying recipients, or by resending. | held |
| RC-06 Fill a mailbox with throwaway identities | stranger | Strangers cannot use up a mailbox so that mail from the owner's contacts is turned away. | **open finding** |
| RC-07 Flood the relay with frames | stranger | A connection that sends faster than the rate limit is closed, and other clients are not affected. | held |
| RC-08 Overwrite a queued message by reusing its id | stranger | A queued message cannot be replaced or duplicated by another account that knows its id. | held |
| RC-09 Send oversized messages and frames | stranger | A message over 256 KB is refused and a frame over the socket limit closes the connection. Neither is stored. | held |
| RC-10 Park mail on the relay for longer than allowed | stranger | The relay stores a message for at most seven days, and not at all if it has already expired. | held |
| RC-11 Hold open connections that never log in | stranger | The relay limits how many connections can sit unauthenticated at once. | **open finding** |
| RC-12 Send malformed frames after logging in | stranger | A logged-in client cannot crash the relay or store anything with malformed frames. | held |
| RC-13 Log in with a credential that is not current | stranger | The relay refuses expired and future-dated credentials, and credentials not signed by their root key. | held |
| RC-14 Reset the rate limit by reconnecting | stranger | The frame rate limit applies to a device, not to one connection. | **open finding** |

### Terminal output

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| OUT-01 Put terminal escape codes and line breaks in a message | contact | Peer text reaches the terminal with every control character escaped, one line per event. | held |
| OUT-02 Use DEL and 8-bit control characters | contact | C1 control characters (U+0080 to U+009F) and DEL are escaped like the 7-bit ones. | **open finding** |
| OUT-03 Reorder or hide text with Unicode formatting characters | contact | Bidirectional overrides, isolates, zero-width characters and Unicode line separators in peer text are shown escaped. | **open finding** |
| OUT-04 Get escape codes into the list of refused messages | contact | The reason shown for a refused message contains nothing the sender wrote. | **open finding** |
| OUT-05 Write to the daemon's terminal from the relay | relay | Nothing the relay sends is printed by the daemon without escaping. | **open finding** |
| OUT-06 Break the machine-readable output | contact | With --json, peer text arrives intact inside valid JSON and no raw control byte is printed. | held |
| OUT-07 Backdate a message | contact | The time shown beside a peer's message is the time it arrived, or is marked as the sender's claim. | **open finding** |

### Local storage

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| STO-01 Read the key file as another local user | stranger | The key file is readable only by its owner, when first written and after every renewal. | held |
| STO-02 Read the message log as another local user | stranger | Nothing in the identity directory is readable by other users, whatever the directory's own permissions were. | **open finding** |
| STO-03 Search the relay's disk for message content | relay | The relay's database holds no plaintext: no message text, goal, thread id or root key. | held |
| STO-04 Read who writes to whom from the relay's disk | relay | The relay stores who a message is for and when it expires, and nothing else about it. | **open finding** |

## Model behaviour

Not measured yet. This section is for attacks on the model that reads peer text (the front desk). Those results will be reported here as rates over repeated trials, separately from the tables above, because they are measurements and not guarantees. The slot is `packages/gauntlet/src/cases/model.ts`.

## What this does not cover

- Timing: the relay's ten second login timeout, sweeping of expired mail, and reconnect backoff are not exercised.
- Two machines, real networks, TLS. Everything runs in one process or over loopback.
- The cryptographic primitives themselves. HPKE and Ed25519 are used as given.
- Crashes in the middle of a write, and several processes sharing one identity directory.
- Faking a log line by padding a message with spaces until the terminal wraps.
- How much an accepted contact can make you store. Nothing caps the threads, messages or contact.hello events an active contact sends.
- A relay that says it stored a message and then drops it. The design accepts that the relay can lose mail.
- macOS and Windows.

---

Generated from commit `515008e` on 2026-11-12 (UTC), Node v24.22.2.
