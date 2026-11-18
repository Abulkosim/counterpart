# Two-device run, 2026-11-18 06:35 UTC

Relay: container, relay in a third container on the devices' network, reached as host.docker.internal; a spare relay in a fourth, reached as relay-b. Model claude-sonnet-5-5, 2.1.326 (Claude Code). Both devices are Docker containers on one Linux host.

Setup: `cpart setup` and `cpart invite devcontainer` on the laptop, `cpart join 42-raven-shade@ws://host.docker.internal:7447 laptop` on the devcontainer, paired by short code in 16s. Agents: laptop Claude Code: here; devcontainer Claude Code: here.
- Human step during setup: devcontainer: typed yes to use a relay on a private address (cpart join ... --yes). join asks before it uses a relay on a private address; without a terminal it said: cpart: this needs a terminal

`cpart relay list` on the laptop after pairing:

```
Your relays (contacts try them in this order):
  home     ws://host.docker.internal:7447  connected

Contacts:
  devcontainer     reach them on ws://host.docker.internal:7447
```

`cpart relay list` on the devcontainer after pairing:

```
Your relays (contacts try them in this order):
  home     ws://host.docker.internal:7447  connected

Contacts:
  laptop           reach them on ws://host.docker.internal:7447
```

| Scenario | Result | First answer | Agreement | Human steps | Lost | Restarted by hand | Took |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 04b-sleep-message | ok | 99.5s | - | 0 | 0 | no | 120s |
| 06b-relay-restart-message | ok | 28.3s | - | 0 | 0 | no | 50s |
| 08a-relay-add-both | ok | none | - | 2 | 0 | no | 20s |
| 08-spare-relay | ok | 11.7s | - | 2 | 0 | no | 53s |

First answer: from the asker's first message or thread goal, whichever came first, to the first reply in that thread, both read from the asker's store and clock. Lost: messages one store holds as sent and the other never applied, after up to 90 seconds to settle. Human steps include approvals, which are meant to be human.

## 04b-sleep-message: As 04, with a prompt that says to send a message, since in 04 the agent put the question in the thread goal and the front desk answers only messages

`scripts/devices/scenarios/04b-sleep-message.json`. Ended as expected.

Faults: pause laptop at 10.2s; unpause laptop at 100.3s.

- Waited for the question, as a message, on the laptop: arrived after 7s.
- Waited for the laptop's answer on the devcontainer: arrived after 5.5s.
- Check the answer names 600 a minute and the 429: pass. 1 message(s); first: The limit is 600 requests a minute per API key. [README.md:28 "600 requests a minute per API key"] Going over returns HTTP 429 with a Retry-After header in seconds. [README.md:28 "Past that you get `429` with a `Retry-After` header in seconds"] The README says to wait that long,
- Check the asker's report to its human has the answer: pass. - **Limit:** 600 requests per minute per API key, counted per calendar minute rather than a sliding window. - **Over it:** you get HTTP 429 with a `Retry-After` header (seconds until the next minute boundary). Requests are rejected, not queued, and there's no permanent block. Retrying before that ti
- laptop daemon log: 1 lost connection(s), 1 (re)connect(s).

Session `asker` on devcontainer: 108s, 6 turns, exit 0, counterpart server connected. Tool calls: counterpart_open_thread, counterpart_say, counterpart_follow, counterpart_wait_for_reply, counterpart_unfollow.

> - **Limit:** 600 requests per minute per API key, counted per calendar minute rather than a sliding window.
> - **Over it:** you get HTTP 429 with a `Retry-After` header (seconds until the next minute boundary). Requests are rejected, not queued, and there's no permanent block. Retrying before that time extends the wait.

## 06b-relay-restart-message: As 06, with a prompt that says to send a message, since in 06 the agent put the question in the thread goal and the front desk answers only messages

`scripts/devices/scenarios/06b-relay-restart-message.json`. Ended as expected.

Faults: relay_restart at 13.7s.

- Waited for the question, as a message, on the laptop: arrived after 7.6s.
- Waited for the laptop's answer on the devcontainer: arrived after 9.2s.
- Check the answer names 50 and 15 minutes: pass. 1 message(s); first: Default page_size is 50 when the client doesn't specify one. [README.md:11 "default 50"] Cursors expire after 15 minutes, per the README. [README.md:12 "Cursors expire after 15 minutes"] Note: server.js does not appear to enforce that expiry. A cursor is just the last SKU, looke
- Check the asker's report to its human has the answer: pass. - Default `page_size` is 50 (max 200; larger values get a 400, not clamped). - Cursors are documented to expire after 15 minutes, but their `server.js` doesn't enforce it (a cursor is just the last SKU), so rely on 15 minutes at most.
- laptop daemon log: 1 lost connection(s), 1 (re)connect(s).
- devcontainer daemon log: 1 lost connection(s), 1 (re)connect(s).

Session `asker` on devcontainer: 38s, 6 turns, exit 0, counterpart server connected. Tool calls: counterpart_open_thread, counterpart_say, counterpart_follow, counterpart_wait_for_reply, counterpart_unfollow.

> - Default `page_size` is 50 (max 200; larger values get a 400, not clamped).
> - Cursors are documented to expire after 15 minutes, but their `server.js` doesn't enforce it (a cursor is just the last SKU), so rely on 15 minutes at most.

## 08a-relay-add-both: No model: both people add the same second relay a second apart; how long until each side knows and has confirmed the other's new list

`scripts/devices/scenarios/08a-relay-add-both.json`. Ended as expected.

- Waited for the laptop holds the devcontainer's new list: arrived after 0.8s.
- Waited for the devcontainer holds the laptop's new list: arrived after 6.7s.
- Waited for the devcontainer has confirmed the laptop's new list: arrived after 0.8s.
- Waited for the laptop has confirmed the devcontainer's new list: arrived after 1s.
- Human step at 0.8s: devcontainer: cpart relay add ws://relay-b:7447. Why: a second relay
- Human step at 1.9s: laptop: cpart relay add ws://relay-b:7447. Why: a second relay
- devcontainer: cpart relay add ws://relay-b:7447 exited 0 after 0.8s: Added ws://relay-b:7447. Your daemon connects to it and tells your contacts.
- laptop: cpart relay add ws://relay-b:7447 exited 0 after 1s: Added ws://relay-b:7447. Your daemon connects to it and tells your contacts.
- laptop: cpart --json relay list exited 0 after 0.9s: {"relays":[{"url":"ws://host.docker.internal:7447","as":null,"home":true,"leaving":false,"connected":true,"at":1794983945858,"error":null},{"url":"ws://relay-b:7447","as":null,"home":false,"leaving":false,"connected":true,"at":1794983964277,"error":null}],"version":1794983964176,"contacts":[{"name":"devcontainer","relays":["ws://host.docker.internal:7447","ws://relay-b:7447"],"version":1794983963127,"seen":1794983964176,"confirmed":true}]}
- devcontainer: cpart --json relay list exited 0 after 0.9s: {"relays":[{"url":"ws://host.docker.internal:7447","as":null,"home":true,"leaving":false,"connected":true,"at":1794983938683,"error":null},{"url":"ws://relay-b:7447","as":null,"home":false,"leaving":false,"connected":true,"at":1794983963185,"error":null}],"version":1794983963127,"contacts":[{"name":"laptop","relays":["ws://host.docker.internal:7447","ws://relay-b:7447"],"version":1794983964176,"seen":1794983963127,"confirmed":true}]}

## 08-spare-relay: Both devices add a second relay; the home relay is killed for good while the front desk is answering, and the conversation goes on over the other

`scripts/devices/scenarios/08-spare-relay.json`. Ended as expected.

Faults: relay_stop (kill) at 17.3s.

- Waited for the laptop knows the devcontainer's new list and has its confirmation: arrived after 0.9s.
- Waited for the devcontainer knows the laptop's new list and has its confirmation: arrived after 1.1s.
- Waited for the question, as a message, on the laptop: arrived after 7.3s.
- Waited for the laptop's answer on the devcontainer, with the home relay dead: arrived after 4.6s.
- Waited for a message from the laptop after the answer: arrived after 0s.
- Waited for a message from the devcontainer after the answer: arrived after 0s.
- Check the answer names the 404 and its code: pass. 2 message(s); first: Unknown SKU on GET /v1/items/:sku returns HTTP 404 with body {"error":{"code":"item_not_found","message":"no item with that SKU"}}. [README.md:24 "404 {"error":{"code":"item_not_found","message":"no item with that SKU"}}"] The server code does the same: status 404, code item_not
- Check the asker's report to its human has the answer: pass. The stockroom agent replied. A missing SKU is a plain `404` with a stable error code. No files were edited.  **What stockroom returns** - `GET /v1/items/:sku` for an unknown SKU returns `404` with `{"error":{"code":"item_not_found","message":"no item with that SKU"}}`. - It never returns a `200` wit
- Human step at 3.3s: devcontainer: cpart relay add ws://relay-b:7447. Why: a second relay, so one going down does not stop the conversation
- Human step at 4.3s: laptop: cpart relay add ws://relay-b:7447. Why: a second relay, so one going down does not stop the conversation
- laptop daemon log: 1 lost connection(s), 1 (re)connect(s).
- devcontainer daemon log: 1 lost connection(s), 0 (re)connect(s).
- devcontainer: cpart relay add ws://relay-b:7447 exited 0 after 1s: ws://relay-b:7447 is already one of your relays.
- laptop: cpart relay add ws://relay-b:7447 exited 0 after 1s: ws://relay-b:7447 is already one of your relays.
- devcontainer: cpart relay list exited 0 after 0.9s: Your relays (contacts try them in this order): home ws://host.docker.internal:7447 not connected: connection closed ws://relay-b:7447 connected Contacts: laptop reach them on ws://host.docker.internal:7447, ws://relay-b:7447 has your current list
- after the steps the rig undid: started the relay

Session `asker` on devcontainer: 26s, 8 turns, exit 0, counterpart server connected. Tool calls: counterpart_open_thread, Grep, counterpart_say, counterpart_follow, counterpart_wait_for_reply, Read, counterpart_unfollow.

> The stockroom agent replied. A missing SKU is a plain `404` with a stable error code. No files were edited.
> 
> **What stockroom returns**
> - `GET /v1/items/:sku` for an unknown SKU returns `404` with `{"error":{"code":"item_not_found","message":"no item with that SKU"}}`.
> - It never returns a `200` with an empty body or null for a single-item lookup.
> - Match on `error.code`, because the codes are stable and the messages are not.
> - A SKU with characters outside `A-Z`, `0-9` and `-` (lowercase, for example) doesn't match the item route. It gets `404` with code `not_found` ("no such path"), so treat that code as a bad SKU or path.
> - A missing or unknown API key returns `401` with code `unauthorized`.
> - Rate limiting returns `429` with a `Retry-After` header in seconds.
> - The list endpoint `/v1/items` returns `200` with empty `items` and a null `next_cursor` when there is nothing to list. It does not return a `404`.
> 
> **What sync.js should handle**
> 
> Right now `sync.js` only calls the list endpoint, never `/v1/items/:sku`. It also has gaps that matter more than the unknown-SKU case:

