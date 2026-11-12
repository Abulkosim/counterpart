# Gauntlet

Counterpart says its security comes from code that limits what can happen, not from asking a model to behave. This is the test of that. Each case below is an attack run against the real code: the protocol library, the relay, the daemon and the `cpart` CLI. The attacker is a stranger, one of your contacts, the relay, or someone on the network.

A case states one rule and tries to break it. "Held" means the attack was refused and the test confirmed nothing else changed. "Open finding" means the attack worked and the defect is not fixed yet. Open findings stay in the suite and are listed first, with the attack and a suggested fix.

This file is generated. Run `pnpm gauntlet` to rebuild it. The same cases run in `pnpm test` on every commit. The cases live in `packages/gauntlet/src/cases`.

## Totals

| Category | Cases | Held | Open findings | Failed |
| --- | ---: | ---: | ---: | ---: |
| Envelope and identity | 20 | 20 | 0 | 0 |
| Canonical form and parsing | 11 | 11 | 0 | 0 |
| Replay and ordering | 13 | 13 | 0 | 0 |
| Authority | 20 | 19 | 1 | 0 |
| The relay as attacker | 10 | 10 | 0 | 0 |
| Clients attacking the relay | 14 | 14 | 0 | 0 |
| Terminal output | 7 | 7 | 0 | 0 |
| Local storage | 4 | 3 | 1 | 0 |
| **All** | **99** | **97** | **2** | **0** |

## Open findings

Most severe first. Each is demonstrated by the case with the same id in the tables below.

### AUT-18: Flush the record of refused messages (low)

- **Rule that should hold:** Everything refused is recorded, and a stranger cannot erase the record of what a contact tried.
- **Who can do it:** stranger
- **What is wrong:** the reject log keeps the newest 1000 rows from any source, so 1000 junk messages push out everything older.
- **Attack:** Mallory, a contact, sends Bob two different events with one sequence number. The second is refused and recorded, which is Bob's only evidence of it. Anyone with a relay login then sends Bob 1000 malformed messages. Each costs the sender nothing to make and adds a reject row. The row about Mallory is deleted.
- **Where:** `packages/daemon/src/node.ts:475`
- **Suggested fix:** Keep separate, separately capped logs for messages that failed to open and for refusals of events from known contacts, or cap per sender root key.

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
| ENV-07 Claim another person's device as your own | contact | An event signed by a device is tied to the one person whose root key vouched for it when it was signed. | held |
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
| ENV-20 Send a contact request with an unusable encryption key | stranger | A message that cannot be answered is refused and recorded like any other bad message. | held |

### Canonical form and parsing

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| PAR-01 Prefix signed bytes with a byte order mark | contact | Input that is not byte for byte canonical is refused. | held |
| PAR-02 Repeat a JSON key with two different values | contact | A payload with a duplicate key is refused, so no two readers can pick different values. | held |
| PAR-03 Spell the same payload another way | contact | Only the canonical spelling of a payload is accepted: no spare whitespace, reordered keys, optional escapes or alternative number forms. | held |
| PAR-04 Use fractions, negatives and oversized numbers | contact | Every number is a non-negative safe integer, or the message is refused. | held |
| PAR-05 Send text that is not well-formed Unicode | contact | Unpaired surrogates and invalid UTF-8 are refused, not repaired. | held |
| PAR-06 Smuggle __proto__ and constructor keys | contact | Keys that name JavaScript internals are treated as unknown fields and refused, and nothing leaks into shared prototypes. | held |
| PAR-07 Invent event types and cross lanes | contact | Only the listed event types are accepted, each in its own lane. | held |
| PAR-08 Go one past every size limit | contact | Over-limit text, goals, parent lists and identifiers are refused whole, never truncated. | held |
| PAR-09 Exhaust the parser with depth and size | contact | Deeply nested or very large payloads are refused quickly and the daemon keeps working. | held |
| PAR-10 Hand over a hostile invite | stranger | A malformed, oversized or tampered invite is refused before anything is stored or sent. | held |
| PAR-11 Respell base64 without changing the bytes | relay | Keys, signatures and ciphertext have one accepted spelling each. | held |

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
| AUT-10 File a contact event inside someone else's thread | contact | Contact events never appear in a thread's log, and one contact cannot touch a thread it is not part of. | held |
| AUT-11 Answer an invite inside an existing thread | contact | A contact request is accepted or refused cleanly whatever thread id it names, and leaves existing threads alone. | held |
| AUT-12 Send pairing events after pairing is done | contact | contact.request and contact.accepted from an established contact are refused and change nothing. | held |
| AUT-13 Complete someone else's pending pairing | contact | Only the person whose invite was accepted can complete that pairing. | held |
| AUT-14 Send before your side of the pairing is confirmed | contact | Until the acceptance arrives, nothing the other side sends is visible or acted on. | held |
| AUT-15 Make the daemon send something | contact | No message from a peer makes the daemon send anything, except the reply to a valid invite. | held |
| AUT-16 Break credential renewal for other contacts | contact | One contact cannot stop the daemon from telling its other contacts about a renewed credential. | held |
| AUT-17 Block a contact's mail from outside | stranger | Someone who is not a contact cannot stop a contact's messages from being delivered and applied. | held |
| AUT-18 Flush the record of refused messages | stranger | Everything refused is recorded, and a stranger cannot erase the record of what a contact tried. | **open finding** |
| AUT-19 Sit in the middle of a pairing | network | Someone who swaps the invite on its way becomes the contact on both sides, and the two safety codes no longer match. | held |
| AUT-20 Show up in another thread before pairing completes | contact | Events held for a contact whose pairing is not complete are not listed in any thread. | held |

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
| RC-06 Fill a mailbox with throwaway identities | stranger | Strangers cannot use up a mailbox so that mail from the owner's contacts is turned away. | held |
| RC-07 Flood the relay with frames | stranger | A connection that sends faster than the rate limit is closed, and other clients are not affected. | held |
| RC-08 Overwrite a queued message by reusing its id | stranger | A queued message cannot be replaced or duplicated by another account that knows its id. | held |
| RC-09 Send oversized messages and frames | stranger | A message over 256 KB is refused and a frame over the socket limit closes the connection. Neither is stored. | held |
| RC-10 Park mail on the relay for longer than allowed | stranger | The relay stores a message for at most seven days, and not at all if it has already expired. | held |
| RC-11 Hold open connections that never log in | stranger | The relay limits how many connections can sit unauthenticated at once. | held |
| RC-12 Send malformed frames after logging in | stranger | A logged-in client cannot crash the relay or store anything with malformed frames. | held |
| RC-13 Log in with a credential that is not current | stranger | The relay refuses expired and future-dated credentials, and credentials not signed by their root key. | held |
| RC-14 Reset the rate limit by reconnecting | stranger | The frame rate limit applies to a device, not to one connection. | held |

### Terminal output

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| OUT-01 Put terminal escape codes and line breaks in a message | contact | Peer text reaches the terminal with every control character escaped, one line per event. | held |
| OUT-02 Use DEL and 8-bit control characters | contact | C1 control characters (U+0080 to U+009F) and DEL are escaped like the 7-bit ones. | held |
| OUT-03 Reorder or hide text with Unicode formatting characters | contact | Bidirectional overrides, isolates, zero-width characters and Unicode line separators in peer text are shown escaped. | held |
| OUT-04 Get escape codes into the list of refused messages | contact | The reason shown for a refused message contains nothing the sender wrote. | held |
| OUT-05 Write to the daemon's terminal from the relay | relay | Nothing the relay sends is printed by the daemon without escaping. | held |
| OUT-06 Break the machine-readable output | contact | With --json, peer text arrives intact inside valid JSON and no raw control byte is printed. | held |
| OUT-07 Backdate a message | contact | The time shown beside a peer's message is the time it arrived, or is marked as the sender's claim. | held |

### Local storage

| Case | Who attacks | The rule | Result |
| --- | --- | --- | --- |
| STO-01 Read the key file as another local user | stranger | The key file is readable only by its owner, when first written and after every renewal. | held |
| STO-02 Read the message log as another local user | stranger | Nothing in the identity directory is readable by other users, whatever the directory's own permissions were. | held |
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

Generated from commit `7e736cb plus uncommitted changes` on 2026-11-12 (UTC), Node v24.22.2.
