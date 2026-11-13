# Protocol v1

Experimental. This will change.

## Encoding

Keys, signatures and ciphertext are unpadded base64url. Anything signed is canonical JSON: RFC 8785 restricted to safe integers and well-formed strings. A receiver rejects input that is not already canonical.

A signature is Ed25519 over `"counterpart/" + domain + "\n" + message`. Domains: `device-credential/v1`, `event/v1`, `relay-auth/v1`, `approval/v1`.

## Identity

```
DeviceCredential { v: 1, rootKey, signKey, encKey, issuedAt, expiresAt, sig }
```

`sig` is the root key's signature over the other fields (domain `device-credential/v1`). The root key is stored locked under a passphrase (scrypt, AES-256-GCM, with the public key and parameters authenticated), so only its owner can renew a device or approve a contract. A root key made without a passphrase can never approve: it may already have been copied. `signKey` is Ed25519, `encKey` is X25519. The device id is `"d_" + base64url(sha256(signKey || encKey)[0..16])`.

The safety code two people compare is 12 decimal digits from `sha256(min(rootA, rootB) || max(rootA, rootB))`.

## Events

```
Event { id, threadId, author, authorSeq, parents[], lane, type, body, createdAt }
```

`author` is a device id. `authorSeq` counts that device's events in the thread from 0. `parents` are ids of earlier events in the thread.

| Type | Lane | Body |
| --- | --- | --- |
| `contact.request` | control | `{ token }` |
| `contact.accepted` | control | `{}` |
| `contact.hello` | control | `{}`. Sent after a device renews its credential, so contacts receive the new one |
| `thread.opened` | control | `{ goal, participants: [rootKey, rootKey] }` |
| `thread.resend` | control | `{ ids }`, 1 to 16 event ids. Asks the other side to send those events again |
| `thread.received` | control | `{ ids }`, 1 to 64 event ids. Says the sender's daemon applied those events |
| `talk.posted` | talk | `{ text, via? }`. `via` is `human`, `agent` or `frontdesk`: the sender's own claim about who wrote it |

| `contract.proposed` | act | `{ contract, supersedes? }` |
| `contract.accepted` | act | `{ approval }` |
| `contract.declined` | act | `{ proposalId, reason? }` |
| `contract.withdrawn` | act | `{ proposalId }` |
| `evidence.posted` | act | `Evidence`. See [Evidence](#evidence) |

Unknown types and unknown fields are rejected.

## Contracts and approvals

```
Contract { v: 1, title, text, parties: [rootKey, rootKey] (sorted), parts: [{ kind, name, content }] }
Approval { v: 1, threadGenesis, proposalId, contractHash, parties, approver, approvedAt, sig }
Agreement { v: 1, contract, contractHash, proposalId, genesis, approvals: [Approval, Approval] }
```

The contract hash is `base64url(sha256(canonical(contract)))` and covers the attached parts. Part kinds are `text`, `json-schema` and `openapi`. A `json-schema` part must parse as a JSON object; nothing else about it is checked.

An approval is the approver's **root key** signature (domain `approval/v1`) over its other fields. `threadGenesis` is the hash of the thread's first event and `proposalId` is the event that proposed the contract, so an approval cannot be moved to another thread, proposal or contract. `approvedAt` is the signer's clock and proves nothing about time.

Rules a daemon enforces:

A proposal is named by the id of the event that made it. The same text proposed twice is two proposals, and approving one is not approving the other.

- A proposal's parties are exactly the thread's two people. Each side may make at most 20 proposals in a thread. `supersedes` must name a proposal the thread has seen.
- An acceptance carries a valid approval whose approver is the sender's root key, bound to this thread and to a proposal of that contract in it. The event lists that proposal among its parents. One approval per person per proposal.
- Only a proposer can withdraw their proposal. A decline or withdrawal must name a proposal the thread has seen.

A contract is agreed when both people have approved the same proposal. Approvals cannot be revoked. Superseding or withdrawing a proposal stops asking for approval; it does not cancel a signature already given, and if the other person signs later the contract is agreed. This is deliberate: two logs that are briefly out of step cannot disagree about whether an agreement exists.

An agreement file holds the contract, the thread's first event and both approvals. Anyone can check it without a daemon: the contract must match its hash, the first event must hash to what the approvals signed and name the same two people, and both approvals must be for the same proposal. It proves the holders of two keys approved the text. It does not prove whose keys they are or that a passphrase was typed.

## Evidence

After publishing, a side tells the other what its repository holds for an agreed proposal.

```
Evidence {
  v: 1, proposalId, contractHash,
  repo,                       a label the sender chose, such as owner/name
  pr?,                        https URL
  head, base,                 commit ids, 40 or 64 lower-case hex
  bindingsHash,               sha256 of the canonical bindings in the trust file on base
  trustPolicyHash,            sha256 of the trust file's bytes on base
  verifier: { version, sha256 },   sha256 of .counterpart/verify.mjs on base
  parts: [{ part, path, sha256?, ok }],
  run?: { url, status: "success" | "failure" }
}
```

Each entry in `parts` is one binding: the contract part's name, the path it is bound to, the sha256 of the file at that path on `head`, and whether the sender found it byte-identical to the signed part. `sha256` is left out when there is no regular file there, and then `ok` must be false.

Limits: `repo` is 1 to 140 characters of `A-Z a-z 0-9 . _ / -`. A URL is at most 300 characters of plain ASCII, starts with `https://`, and has no user name or password. A path is at most 300 printable ASCII characters, relative, with no `.` or `..` segment, backslash or colon. There are 1 to 32 parts, and no two share a part and a path. Hashes are 64 lower-case hex characters. The verifier version is at most 16 characters. Anything else is refused.

Rules a daemon enforces:

- The proposal is one this thread has seen, `contractHash` is that proposal's hash, and both people have approved it. Evidence for anything else is refused, not stored.
- Each side may send at most 100 in a thread.

Everything in evidence is the sender's claim. The receiver recomputes only what it holds:

- The proposal and contract hash are an agreed contract in this thread. This is the acceptance rule above.
- Each part's digest against the sha256 of the signed part's UTF-8 bytes: match, mismatch, no file, or no such part in the contract. The sender's `ok` is shown but decides nothing.
- The verifier hash against the verifier the receiver's own install ships.

A matching digest shows the sender named the right bytes. It does not show their repository holds them. The repository label, the commits, the two policy hashes, the pull request and the CI run are shown as the sender's claim and are never marked checked. URLs are printed as text. Nothing fetches them.

Per proposal and per side, the newest evidence (in the order the receiver applied it) is current. An older one is stale if the current one names a different `head`, `base`, `bindingsHash` or `trustPolicyHash`, and otherwise replaced.

## Envelope

```
Wire   { header, enc, ct }
Header { v: 1, suite, id, to, expiresAt }
```

Suite `hpke-x25519-hkdfsha256-chacha20poly1305+ed25519/v1`.

To send: sign `canonical({ header, event, credential: hash(credential) })` with the device signing key (domain `event/v1`). The plaintext is `canonical({ event, sig, credential })`. Encrypt with HPKE base mode to the recipient's `encKey`, with info `counterpart/envelope/v1` and the canonical header as associated data.

To receive: check the header is addressed to this device and not expired; decrypt; require canonical plaintext; verify the credential; check `event.id == header.id` and `event.author` is the credential's device id; verify the signature. Then decide whether the credential's root key is someone you accept messages from.

Because the signature covers the header, a recipient cannot re-encrypt a signed event to a third party. Because it covers the credential, the same device key vouched for by another root cannot reuse it. Credentials whose encryption key is a small-order point are refused.

## Receiving rules

A daemon applies an event only if all hold:

- The sender's root key is an active contact, or the event is a `contact.request` carrying an unused, unexpired invite token.
- Contact events (`contact.request`, `contact.accepted`, `contact.hello`) stand alone: sequence 0, no parents, and a thread id nothing else uses.
- A thread belongs to one contact. An event naming it from anyone else is refused, never held.
- The event id is new. The same id with the same content is a duplicate and is ignored. The same id with different content is refused.
- No other event has the same thread, author and sequence number.
- `thread.opened` is the author's event 0 with no parents, and its participants are exactly the two root keys.
- Events from a contact whose acceptance has not arrived yet are held and applied when it does.
- For other events, the thread exists, the sender is its other participant, and all parents have been applied. If the thread or a parent is missing, the event is held (up to 200 per contact) and applied when they arrive. Parents that stay missing are asked for: see Resend and receipts.

Everything refused is recorded with a reason.

## Resend and receipts

`thread.resend` and `thread.received` are sealed and signed like any event and name the thread in `threadId`, but they are not part of its log. They have sequence 0 and no parents, are never stored as events, never held, and are not shown to a person, an agent or the front desk. A daemon accepts one only from an active contact who is the other participant of the named thread. A thread that belongs to someone else and a thread that does not exist get the same refusal.

**Asking.** When events from a contact have been held for 30 seconds, the daemon collects the parents those held events name that it has no copy of, and sends one `thread.resend` for the thread with up to 16 of them. If an event sent again is held in turn, its missing parents are asked for next, back to `thread.opened`. The daemon asks again after 60 seconds, then doubles the wait up to an hour, and stops after 8 requests. It starts over when a held event in that thread is applied, or after seven days. It sends one contact at most 5 requests a minute over all threads. A request expires after one day.

**Answering.** For each id, the daemon sends the event again only if it wrote that event itself, in the named thread. The event is unchanged (same id, same content), sealed again to the contact's current credential with a new expiry. Other ids are skipped. A request that names nothing it can send is refused. The daemon answers one request per contact and thread in 30 seconds, requests in at most 20 threads per contact in ten minutes, and sends any one event again at most 5 times ever. A request that arrives early is refused and recorded. The answer to a request is never another request.

**Receipts.** About a second after applying a contact's thread events, a daemon sends one `thread.received` per thread listing up to 64 of them. Contact events, resend requests, receipts, duplicates and held events are not receipted. On receipt, the sender marks its own events in that thread as received. Other ids are ignored. An event's delivery state is then one of:

| State | Meaning |
| --- | --- |
| `queued` | Not yet accepted by the relay |
| `stored` | The relay accepted it. Nothing is known about the recipient |
| `received` | The recipient's daemon signed a receipt for it |
| `failed`, `expired` | The relay refused it, or it expired before it could be sent |

`received` is the contact's claim. It means their daemon applied the event, not that a person or agent read it. A contact can withhold receipts, so `stored` does not prove the event was not applied.

## Relay

JSON frames over WebSocket.

```
relay  -> { t: "challenge", nonce }
client -> { t: "auth", credential, relay, sig }     sig over canonical({ nonce, relay }), domain relay-auth/v1
relay  -> { t: "ready", device }
client -> { t: "send", wire }
relay  -> { t: "stored", id } | { t: "error", code, id }
relay  -> { t: "deliver", wire }
client -> { t: "ack", id, ok }                     ok: the message was accepted, not refused
```

`relay` is the URL the client dialled. The relay accepts a login only for its own configured URL, so another relay cannot forward a challenge to its clients and log in as them. The relay stores a message until the recipient acknowledges it or it expires (seven days at most). Delivery is at least once. Sending the same message again is accepted; reusing an id for different bytes returns `conflict`. The relay sends a limited window of deliveries and sends more as they are acknowledged. Other codes: `mailbox_full`, `expired`, `ttl_too_long`, `too_large`, `bad_wire`.

A client acknowledges only after it has durably recorded its decision about the message. A message that fails locally three times is acknowledged as refused so it cannot block the ones behind it.

A sender becomes known to a recipient once the recipient has accepted a message from it. Senders who are not known share a small allowance per mailbox (50 messages, 5 per sender), so throwaway identities cannot fill a mailbox. Rate limits follow the device across reconnects, and the relay holds at most 128 connections that have not logged in.
