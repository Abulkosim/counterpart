# Verification

What has actually been run, and what has not.

| Date (UTC) | What was run | Result | Not checked |
| --- | --- | --- | --- |
| 2026-11-12 | `pnpm verify`: 29 tests (33 after review fixes) across protocol, relay and daemon (pairing, offline delivery, duplicates, reordering, strangers, invite reuse, thread hijack, sequence reuse, restart, credential renewal) | Pass on Linux, Node 24.22 | macOS, Windows |
| 2026-11-12 | `scripts/smoke.sh`: relay and two daemons as real processes, CLI only. Bob killed and restarted, relay killed and restarted, a message with terminal escape codes | Both logs match, 6 events in sent order, escape codes shown as text, no plaintext in the relay database | Two separate machines. Everything ran on one host over loopback |
| 2026-11-12 | Codex (gpt-6-astra) reviewed the M0 source. Eight findings; seven fixed with tests (login forwarding between relays, sender-wide and relay-wide queue limits, delivery windows, pairing race, reconnect on local failure, credential renewal in a running daemon, atomic key file writes, cursor API). `pnpm verify` 33 tests, `scripts/smoke.sh` | Pass | The eighth finding is open: see Known limits |

## Known limits

- The encryption has had no outside review.
- No forward secrecy. A leaked device key exposes recorded messages to that device.
- The root key sits on the same device as the device key. A stolen laptop is a stolen identity until contacts remove you by hand. Revocation is not built.
- One device per person.
- If a message expires on the relay before the recipient comes online (seven days), later messages in that thread wait forever for it. There is no way yet to ask a peer to resend. Tracked in issue #4.
- A contact whose device credential has expired cannot be written to until they send something.
