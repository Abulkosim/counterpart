# Verification

What has actually been run, and what has not.

| Date (UTC) | What was run | Result | Not checked |
| --- | --- | --- | --- |
| 2026-11-12 | `pnpm verify`: 29 tests across protocol, relay and daemon (pairing, offline delivery, duplicates, reordering, strangers, invite reuse, thread hijack, sequence reuse, restart, credential renewal) | Pass on Linux, Node 24.22 | macOS, Windows |
| 2026-11-12 | `scripts/smoke.sh`: relay and two daemons as real processes, CLI only. Bob killed and restarted, relay killed and restarted, a message with terminal escape codes | Both logs match, 6 events in sent order, escape codes shown as text, no plaintext in the relay database | Two separate machines. Everything ran on one host over loopback |

## Known limits

- The encryption has had no outside review.
- No forward secrecy. A leaked device key exposes recorded messages to that device.
- The root key sits on the same device as the device key. A stolen laptop is a stolen identity until contacts remove you by hand. Revocation is not built.
- One device per person.
- A contact whose device credential has expired cannot be written to until they send something.
