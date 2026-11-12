# Protocol v1

Experimental. This will change.

## Encoding

Keys, signatures and ciphertext are unpadded base64url. Anything signed is canonical JSON: RFC 8785 restricted to safe integers and well-formed strings. A receiver rejects input that is not already canonical.

A signature is Ed25519 over `"counterpart/" + domain + "\n" + message`. Domains: `device-credential/v1`, `event/v1`, `relay-auth/v1`.

## Identity

```
DeviceCredential { v: 1, rootKey, signKey, encKey, issuedAt, expiresAt, sig }
```

`sig` is the root key's signature over the other fields (domain `device-credential/v1`). `signKey` is Ed25519, `encKey` is X25519. The device id is `"d_" + base64url(sha256(signKey || encKey)[0..16])`.

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
| `talk.posted` | talk | `{ text }` |

Unknown types and unknown fields are rejected.

## Envelope

```
Wire   { header, enc, ct }
Header { v: 1, suite, id, to, expiresAt }
```

Suite `hpke-x25519-hkdfsha256-chacha20poly1305+ed25519/v1`.

To send: sign `canonical({ header, event })` with the device signing key (domain `event/v1`). The plaintext is `canonical({ event, sig, credential })`. Encrypt with HPKE base mode to the recipient's `encKey`, with info `counterpart/envelope/v1` and the canonical header as associated data.

To receive: check the header is addressed to this device and not expired; decrypt; require canonical plaintext; verify the credential; check `event.id == header.id` and `event.author` is the credential's device id; verify the signature. Then decide whether the credential's root key is someone you accept messages from.

Because the signature covers the header, a recipient cannot re-encrypt a signed event to a third party.

## Receiving rules

A daemon applies an event only if all hold:

- The sender's root key is an active contact, or the event is a `contact.request` carrying an unused, unexpired invite token.
- The event id is new. The same id with the same content is a duplicate and is ignored. The same id with different content is refused.
- No other event has the same thread, author and sequence number.
- `thread.opened` is the author's event 0 with no parents, and its participants are exactly the two root keys.
- Events from a contact whose acceptance has not arrived yet are held and applied when it does.
- For other events, the thread exists, the sender is its other participant, and all parents have been applied. If the thread or a parent is missing, the event is held (up to 200 per contact) and applied when they arrive.

Everything refused is recorded with a reason.

## Relay

JSON frames over WebSocket.

```
relay  -> { t: "challenge", nonce }
client -> { t: "auth", credential, relay, sig }     sig over canonical({ nonce, relay }), domain relay-auth/v1
relay  -> { t: "ready", device }
client -> { t: "send", wire }
relay  -> { t: "stored", id } | { t: "error", code, id }
relay  -> { t: "deliver", wire }
client -> { t: "ack", id }
```

`relay` is the URL the client dialled. The relay accepts a login only for its own configured URL, so another relay cannot forward a challenge to its clients and log in as them. The relay stores a message until the recipient acknowledges it or it expires (seven days at most). Delivery is at least once. Sending the same message again is accepted; reusing an id for different bytes returns `conflict`. The relay sends a limited window of deliveries and sends more as they are acknowledged. Other codes: `mailbox_full`, `expired`, `ttl_too_long`, `too_large`, `bad_wire`.

A client acknowledges only after it has durably recorded its decision about the message.
