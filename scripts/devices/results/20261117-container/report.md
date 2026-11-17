# Two-device run, 2026-11-17 22:22 UTC

Relay: container, relay in a third container on the devices' network, reached as host.docker.internal. Model claude-sonnet-5-5, 2.1.326 (Claude Code). Both devices are Docker containers on one Linux host.

Setup: `cpart setup` on the laptop, `cpart join` on the devcontainer, paired in 23s. Safety codes match. Agents: laptop Claude Code: here; devcontainer Claude Code: here.
- Human step during setup: devcontainer: typed yes to use a relay on a private address (cpart join ... --yes). join asks before it uses a relay on a private address; without a terminal it said: cpart: this needs a terminal

| Scenario | Result | First answer | Agreement | Human steps | Lost | Restarted by hand | Took |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 00-plumbing | **needed a restart** | 3.3s | - | 2 | 0 | yes | 552s |
| 01-ask | ok | 8.7s | - | 0 | 0 | no | 33s |
| 02-negotiate | ok | none | 41s | 2 | 0 | no | 58s |
| 03-offline | ok | 121.9s | - | 0 | 0 | no | 148s |
| 04-sleep | ok | 95.4s | - | 0 | 0 | no | 113s |
| 05-network-drop | **failed** | none | - | 1 | 0 | yes | 565s |
| 06-relay-restart | ok | 6.2s | - | 0 | 0 | no | 277s |

First answer: from the asker's question to the first reply in the asker's store, both by the asker's clock. Lost: messages one store holds as sent and the other never applied, after up to 90 seconds to settle. Human steps include approvals, which are meant to be human.

## 00-plumbing: No model: messages by hand through sleep, a network drop and a relay restart

`scripts/devices/scenarios/00-plumbing.json`. **Did not end as expected.**

Faults: pause laptop at 7.5s; unpause laptop at 53.4s; disconnect laptop at 56.1s; connect laptop at 77s; disconnect laptop at 87.4s; connect laptop at 118.4s; relay_restart at 314.7s; disconnect devcontainer at 325.2s; connect devcontainer at 356.4s.

- Waited for ping 1 on the laptop: arrived after 0.1s.
- Waited for pong 1 on the devcontainer: arrived after 0s.
- Waited for ping 2 on the laptop after it wakes: arrived after 0s.
- Waited for ping 2b on the laptop, back at the same address: arrived after 7.5s.
- Waited for ping 3 on the laptop after the network is back: arrived after 188.1s, after the rig restarted the daemons.
- Waited for pong 3 on the devcontainer: arrived after 0.1s.
- Waited for ping 4 on the laptop after the relay restart: arrived after 0.8s.
- Waited for pong 4 on the devcontainer after its network is back: arrived after 185.4s, after the rig restarted the daemons.
- **Restart by hand** at 306.6s: cpart down, then cpart up, on laptop. Why: ping 3 on the laptop after the network is back had not arrived 180s after the wait began; laptop's cpart status said the daemon was running and connected
- **Restart by hand** at 542.1s: cpart down, then cpart up, on devcontainer. Why: pong 4 on the devcontainer after its network is back had not arrived 180s after the wait began; devcontainer's cpart status said the daemon was running and connected
- laptop daemon log: 1 lost connection(s), 2 (re)connect(s).
- devcontainer daemon log: 1 lost connection(s), 2 (re)connect(s).

## 01-ask: The devcontainer's agent asks a question only the laptop's repo can answer; the laptop's front desk answers

`scripts/devices/scenarios/01-ask.json`. Ended as expected.

- Waited for the laptop's answer on the devcontainer: arrived after 18.8s.
- Check the answer names the 200 limit and the null cursor: pass. 1 message(s); first: (1) stockroom rejects page_size=500. It does not honor it or clamp it. The maximum is 200, and anything above that gets `400 {"error":{"code":"page_size_too_large"}}` (from README.md). The item count is not a signal, because no items come back at all. The server code behaves the
- Check the asker's report to its human names both: pass. Stockroom's agent answered, so here is what to change in `sync.js`. I haven't edited any file.  1. **Page size (line 10):** stockroom rejects `page_size=500` with `400 page_size_too_large`. The maximum is 200. Change the value to `"200"` or lower. 2. **Loop end (line 16):** on the last page `next_cu

Session `asker` on devcontainer: 23s, 7 turns, exit 0, counterpart server connected. Tool calls: Grep, counterpart_contacts, Read, counterpart_open_thread, counterpart_say, counterpart_wait_for_reply.

> Stockroom's agent answered, so here is what to change in `sync.js`. I haven't edited any file.
> 
> 1. **Page size (line 10):** stockroom rejects `page_size=500` with `400 page_size_too_large`. The maximum is 200. Change the value to `"200"` or lower.
> 2. **Loop end (line 16):** on the last page `next_cursor` is `null`. It is never omitted. `cursor !== undefined` will therefore never end the loop. Use `while (cursor)` or `cursor != null`.
> 3. **Status check (after line 12):** a 400 response has no `next_cursor` and no `items`. Today that would make `all.push(...page.items)` throw, or the sync would end silently with nothing. Add `if (!res.ok) throw new Error(...)` before parsing the body.
> 4. **Cursor expiry:** cursors expire after 15 minutes, so a very slow sync could fail partway through. An empty stockroom returns `{"items": [], "next_cursor": null}` with a 200, which the current code already handles.
> 
> Laptop's agent said its answers come from stockroom's README.md and server.js. I haven't checked them against those files myself.

## 02-negotiate: Two live sessions negotiate a small contract, taking turns; both humans approve it

`scripts/devices/scenarios/02-negotiate.json`. Ended as expected.

- Waited for the proposal on the devcontainer: arrived after 0s.
- Check both sides hold the agreement: pass. agreed on laptop: true, on devcontainer: true
- Human step at 43.7s: laptop approves "stockroom list API: page_size up to 250 at a lower rate limit" (cpart approve). Why: only a human can sign
- Human step at 45.4s: devcontainer approves "stockroom list API: page_size up to 250 at a lower rate limit" (cpart approve). Why: only a human can sign

Session `laptop-1` on laptop: 19s, 5 turns, exit 0, counterpart server connected. Tool calls: counterpart_contacts, counterpart_open_thread, Grep, counterpart_propose_contract.

> I opened a thread with devcontainer and proposed the contract. I did not wait for a reply, so nothing is agreed yet. A proposal binds nobody until both humans approve it.
> 
> - **Thread:** `yhHw7XuyNRgHOleDFAwGtw`
> - **Proposal:** `btdizuaA07iUfX4psB03wg`
> 
> **What the contract says:**
> - **Standard tier (default):** page_size up to 200 and 600 requests a minute.
> - **Large-page tier:** page_size up to 250, only while they send fewer than 300 requests a minute, measured over any rolling 60 seconds. If they hit 300 or more, page_size above 200 is refused and they go back to the standard tier.
> - **Over-limit page_size:** refused with `400 page_size_too_large`, not clamped.
> - **Cursors:** expire 15 minutes after they are issued, under both tiers. An expired cursor means restarting from the first page.
> - **Last page:** it has 0 to page_size items, and `next_cursor` is always present and `null`. An empty listing returns `200 {"items": [], "next_cursor": null}`. They must stop on a null cursor, not on a short page.
> 
> **Please check these before approving:**
> - **Last page wording:** I took it from the current behaviour in `README.md:20` and `server.js:37`, so it describes what the API already does.

Session `devcontainer-1` on devcontainer: 12s, 4 turns, exit 0, counterpart server connected. Tool calls: counterpart_read_thread, counterpart_contracts, counterpart_read_contract.

> I left the proposal open and changed nothing. It already gives you what you need, so I made no counter-proposal and no decline.
> 
> **What's on the table**
> 
> Proposal `btdizuaA07iU` from laptop is the only one, and it is open with no approvals. It covers the stockroom list API:
> - **Two tiers, and you use exactly one:**
>   - Standard: `page_size` 1–200 at 600 requests a minute.
>   - Large-page: `page_size` 1–250 at 300 requests a minute, meaning fewer than 300 in any rolling 60 seconds.
> - **Going over the rate:** If you send 300 or more requests in a minute while using `page_size` above 200, the large-page tier stops applying. Sizes above 200 are then refused, and you fall back to the standard tier.
> - **Oversized pages:** A `page_size` above the tier maximum returns 400 `page_size_too_large`. It is not clamped.
> - **Cursors:** They expire 15 minutes after they are issued. After an expiry you restart the listing from page 1.
> - **Last page:** `next_cursor` is always present and is `null` on the final page. An empty listing returns 200 with `{"items": [], "next_cursor": null}`. You must stop on `null` and must not infer the end from a short page.
> - **Everything else:** Other limits and behaviour stay as the stockroom README has them.
> 

Session `laptop-2` on laptop: 9s, 4 turns, exit 0, counterpart server connected. Tool calls: counterpart_read_thread, counterpart_contracts, counterpart_read_contract.

> I left proposal `btdizuaA07iU` open and unchanged. It's your own proposal, and it already gives you what you need.
> 
> - **Tiers:** the standard tier is page_size up to 200 at 600 requests a minute. The large-page tier is page_size up to 250 at fewer than 300 requests a minute, measured over a rolling 60 seconds. If shelf-sync sends 300 or more in a minute while using page sizes above 200, the large-page tier stops applying and they fall back to standard.
> - **Oversized pages:** a page_size above the tier maximum is refused with a 400 `page_size_too_large`, not clamped.
> - **Cursors:** they expire after 15 minutes under either tier, and an expired cursor means restarting the listing from page one.
> - **Last page:** `next_cursor` is always present and is null on the final page. An empty listing returns 200 with `{"items": [], "next_cursor": null}`. Shelf-sync must stop on a null `next_cursor`, not on a short page.
> - **Everything else:** other limits and behaviour stay as in the stockroom README.
> 
> The thread has no reply from devcontainer yet, so they haven't accepted, declined or countered. Nobody has approved the proposal either. If you're happy with the text, approve it by running `cpart approve yhHw7XuyNRgHOleDFAwGtw btdizuaA07iU` in your terminal. I can't do that for you, and I haven't told the other side that you will.

## 03-offline: The laptop is offline when the question is sent and comes back two minutes later, at the same address

`scripts/devices/scenarios/03-offline.json`. Ended as expected.

Faults: disconnect laptop at 2s; connect laptop at 122.1s.

- Waited for the laptop's answer on the devcontainer: arrived after 8s.
- Check the answer names the 404 and its code: pass. 1 message(s); first: For a SKU that does not exist, GET /v1/items/:sku returns HTTP 404 with this body (from README.md):  {"error":{"code":"item_not_found","message":"no item with that SKU"}}  All errors share the shape {"error":{"code":"...","message":"..."}}. The codes are stable and the messages 
- Check the asker's report to its human has the answer: pass. I have the answer from laptop's agent and I'm summarizing it now. I haven't edited any files.  **What stockroom returns for a missing SKU** (per laptop's agent, which cited their README.md) - `GET /v1/items/:sku` returns HTTP 404 with `{"error":{"code":"item_not_found","message":"no item with that S

Session `asker` on devcontainer: 137s, 8 turns, exit 0, counterpart server connected. Tool calls: counterpart_contacts, Grep, Read, counterpart_open_thread, counterpart_say, counterpart_wait_for_reply, counterpart_wait_for_reply.

> I have the answer from laptop's agent and I'm summarizing it now. I haven't edited any files.
> 
> **What stockroom returns for a missing SKU** (per laptop's agent, which cited their README.md)
> - `GET /v1/items/:sku` returns HTTP 404 with `{"error":{"code":"item_not_found","message":"no item with that SKU"}}`.
> - All errors use `{"error":{"code","message"}}`. The codes are stable and the messages are not, so match on `code`.
> - A path that doesn't exist returns 404 with code `not_found`. Only `item_not_found` means "no such SKU".
> - `/v1/items` has no documented SKU filter. It always returns 200, and an empty result is `{"items": [], "next_cursor": null}`.
> - Other errors: 401 `unauthorized`, 400 `page_size_too_large` (page_size above 200), and 429 with a `Retry-After` header (seconds) above 600 requests a minute per key.
> 
> **What sync.js should handle**
> sync.js never requests a single SKU. It only pages through `/v1/items`, so `item_not_found` can't occur today. It would matter only if you add per-SKU lookups. The bigger problem is that sync.js doesn't match this API in several places:
> 1. **Page size (`sync.js:10`):** it sends `page_size=500`, and the API rejects anything above 200 with a 400. Use 200 or less.
> 2. **Error responses (`sync.js:12-14`):** it never checks `res.ok`. On a 400, 401 or 429, `page.items` is undefined and `all.push(...undefined)` throws. It should check the status and read `error.code`. For 429 it should wait `Retry-After` seconds and retry.
> 3. **End of pagination (`sync.js:16`):** the loop ends only when `cursor === undefined`, but the API sends `next_cursor: null` on the last page. The loop would never end, and the next request would send `cursor=null`. Use `while (cursor != null)` or `while (cursor)`.

## 04-sleep: The laptop goes to sleep for 90 seconds just as the question reaches it, while its front desk is writing the answer

`scripts/devices/scenarios/04-sleep.json`. Ended as expected.

Faults: pause laptop at 6.5s; unpause laptop at 96.6s.

- Waited for the question on the laptop: arrived after 3.2s.
- Waited for the laptop's answer on the devcontainer: arrived after 5.3s.
- Check the answer names 600 a minute and the 429: pass. 1 message(s); first: Limit: 600 requests per minute, per API key (from README.md).  When you go over it: the API returns `429` with a `Retry-After` header giving seconds to wait. The README says to wait that long, and that retrying sooner extends the wait (from README.md). The error body follows the
- Check the asker's report to its human has the answer: pass. - **Limit:** 600 requests/minute per API key, counted in fixed clock-minute windows (not sliding). - **Over it:** you get a `429` (`rate_limited`) with a `Retry-After` header giving the seconds left in the minute. Retrying sooner extends the wait by an undefined amount. Nothing mentioned about longe

Session `asker` on devcontainer: 103s, 4 turns, exit 0, counterpart server connected. Tool calls: counterpart_open_thread, counterpart_say, counterpart_wait_for_reply.

> - **Limit:** 600 requests/minute per API key, counted in fixed clock-minute windows (not sliding).
> - **Over it:** you get a `429` (`rate_limited`) with a `Retry-After` header giving the seconds left in the minute. Retrying sooner extends the wait by an undefined amount. Nothing mentioned about longer blocks or key suspension.
> 
> I didn't edit any files.

## 05-network-drop: The devcontainer's network drops while the laptop replies, and comes back a minute later at a new address

`scripts/devices/scenarios/05-network-drop.json`. **Did not end as expected.** the laptop's answer on the devcontainer: nothing after 480s

Faults: disconnect devcontainer at 9s; connect devcontainer at 69.1s.

- Waited for the question on the laptop: arrived after 3.8s.
- Waited for the laptop's answer on the devcontainer: never arrived, after the rig restarted the daemons.
- **Restart by hand** at 377.3s: cpart down, then cpart up, on devcontainer. Why: the laptop's answer on the devcontainer had not arrived 300s after the wait began; devcontainer's cpart status said the daemon was running and connected

Session `asker` on devcontainer: 497s, 7 turns, exit 0, counterpart server connected. Tool calls: counterpart_contacts, counterpart_open_thread, counterpart_wait_for_reply, counterpart_wait_for_reply, counterpart_wait_for_reply, counterpart_wait_for_reply.

> The laptop agent hasn't answered yet, so I can't tell you what to put in sync.js. I waited about 8 minutes across four checks and got nothing.
> 
> I opened thread `uX2qSohDdyS_W6qScs36rg` with laptop and asked three things:
> - How a client authenticates: mechanism, header or param names, and key format.
> - What status code a bad key gets back.
> - What body a bad key gets back.
> 
> The relay stored the message, but laptop hasn't picked it up. Their agent may be offline, or their human may not have it running.
> 
> I haven't edited any files and I haven't guessed at the auth scheme. Any header name or error shape I made up could be wrong.
> 
> Do you want me to keep waiting, or would you rather check with the warehouse team directly? Once a reply arrives I'll turn it into the exact change for sync.js.

## 06-relay-restart: The relay restarts while the laptop's front desk is answering

`scripts/devices/scenarios/06-relay-restart.json`. Ended as expected.

Faults: relay_restart at 14.4s.

- Waited for the question on the laptop: arrived after 7s.
- Waited for the laptop's answer on the devcontainer: arrived after 234.7s.
- Check the answer names 50 and 15 minutes: pass. 1 message(s); first: 1) The default page_size is 50. Allowed values are 1 to 200, and anything above 200 is refused with a 400 `page_size_too_large`, not clamped (from README.md; server.js uses the same default of 50).  2) A cursor expires after 15 minutes (from README.md). The cursor is the `next_c
- Check the asker's report to its human has the answer: pass. - Default `page_size` is 50 (allowed 1–200; above 200 returns a 400 `page_size_too_large` rather than being clamped). - Cursors expire after 15 minutes per their README, but their server.js doesn't enforce it (the cursor is just a SKU), so that limit is documented, not verified.  I didn't edit any f
- laptop daemon log: 1 lost connection(s), 1 (re)connect(s).
- devcontainer daemon log: 1 lost connection(s), 1 (re)connect(s).

Session `asker` on devcontainer: 261s, 7 turns, exit 0, counterpart server connected. Tool calls: counterpart_contacts, counterpart_open_thread, counterpart_wait_for_reply, counterpart_wait_for_reply, counterpart_say, counterpart_wait_for_reply.

> - Default `page_size` is 50 (allowed 1–200; above 200 returns a 400 `page_size_too_large` rather than being clamped).
> - Cursors expire after 15 minutes per their README, but their server.js doesn't enforce it (the cursor is just a SKU), so that limit is documented, not verified.
> 
> I didn't edit any files.

