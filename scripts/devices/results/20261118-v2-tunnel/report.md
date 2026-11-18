# Two-device run, 2026-11-18 06:40 UTC

Relay: tunnel, relay process on this machine behind cpart relay --tunnel (cloudflared quick tunnel); the devices reach it over the internet. Model claude-sonnet-5-5, 2.1.326 (Claude Code). Both devices are Docker containers on one Linux host.

Setup: `cpart setup` and `cpart invite devcontainer` on the laptop, `cpart join 52-pound-lift@wrist-handbags-able-regularly.trycloudflare.com laptop` on the devcontainer, paired by short code in 30s. Agents: laptop Claude Code: here; devcontainer Claude Code: here.

`cpart relay list` on the laptop after pairing:

```
Your relays (contacts try them in this order):
  home     wss://wrist-handbags-able-regularly.trycloudflare.com  connected

Contacts:
  devcontainer     reach them on wss://wrist-handbags-able-regularly.trycloudflare.com
```

`cpart relay list` on the devcontainer after pairing:

```
Your relays (contacts try them in this order):
  home     wss://wrist-handbags-able-regularly.trycloudflare.com  connected

Contacts:
  laptop           reach them on wss://wrist-handbags-able-regularly.trycloudflare.com
```

| Scenario | Result | First answer | Agreement | Human steps | Lost | Restarted by hand | Took |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01-ask | ok | 12.9s | - | 0 | 0 | no | 41s |
| 04b-sleep-message | ok | 98.5s | - | 0 | 0 | no | 121s |
| 05b-network-drop-message | ok | 66.4s | - | 0 | 0 | no | 220s |
| 06t-tunnel-restart-move | ok | 36.7s | - | 4 | 0 | no | 61s |
| 06b-relay-restart-message | **failed** | none | - | 3 | 1 | yes | 753s |

First answer: from the asker's first message or thread goal, whichever came first, to the first reply in that thread, both read from the asker's store and clock. Lost: messages one store holds as sent and the other never applied, after up to 90 seconds to settle. Human steps include approvals, which are meant to be human.

## 01-ask: The devcontainer's agent asks a question only the laptop's repo can answer; the laptop's front desk answers

`scripts/devices/scenarios/01-ask.json`. Ended as expected.

- Waited for the laptop's answer on the devcontainer: arrived after 20s.
- Check the answer names the 200 limit and the null cursor: pass. 1 message(s); first: (1) page_size=500 is rejected, not honored or capped: the API answers 400 with code page_size_too_large. [README.md:11 "It is not clamped."] The code confirms it: any size above MAX_PAGE (200) returns 400 page_size_too_large. [server.js:32 "if (size > MAX_PAGE)"] The allowed ran
- Check the asker's report to its human names both: pass. The laptop agent says sync.js pages through items incorrectly in two places. I haven't edited any file.  **What to change in sync.js:** 1. **Page size (line 10):** change `page_size` from `"500"` to `"200"` or lower. Stockroom doesn't clamp the value. Anything above 200 gets a 400 `page_size_too_lar

Session `asker` on devcontainer: 27s, 8 turns, exit 0, counterpart server connected. Tool calls: Grep, counterpart_contacts, counterpart_open_thread, counterpart_say, counterpart_follow, counterpart_wait_for_reply, counterpart_unfollow.

> The laptop agent says sync.js pages through items incorrectly in two places. I haven't edited any file.
> 
> **What to change in sync.js:**
> 1. **Page size (line 10):** change `page_size` from `"500"` to `"200"` or lower. Stockroom doesn't clamp the value. Anything above 200 gets a 400 `page_size_too_large`. The allowed range is 1–200 and the default is 50.
> 2. **Loop condition (line 16):** change `while (cursor !== undefined)` to `while (cursor !== null)`. On the last page `next_cursor` is `null`, never absent. As written, the loop never ends after the last page. An empty stock list returns 200 with `items: []` and `next_cursor: null`.
> 
> Cursors also expire after 15 minutes, so a sync that runs longer than that could fail partway through. It's worth handling.
> 
> These answers come from laptop's agent, which quoted the stockroom README and server.js at commit 42a10639fbf5. I haven't checked them against the stockroom code myself.

## 04b-sleep-message: As 04, with a prompt that says to send a message, since in 04 the agent put the question in the thread goal and the front desk answers only messages

`scripts/devices/scenarios/04b-sleep-message.json`. Ended as expected.

Faults: pause laptop at 13.7s; unpause laptop at 103.8s.

- Waited for the question, as a message, on the laptop: arrived after 7.2s.
- Waited for the laptop's answer on the devcontainer: arrived after 1s.
- Check the answer names 600 a minute and the 429: pass. 1 message(s); first: The limit is 600 requests a minute per API key. [README.md:28 "600 requests a minute per API key"] Going over it returns HTTP 429 with a Retry-After header giving seconds to wait. [README.md:28 "Past that you get `429` with a `Retry-After` header in seconds"] Retrying sooner ext
- Check the asker's report to its human has the answer: pass. - **Limit:** stockroom allows 600 requests per minute per API key, counted per clock minute. - **Over it:** you get HTTP 429 (`rate_limited`) with a `Retry-After` header in seconds. Retrying before that time extends the wait. Their reply didn't mention any longer-term blocking of a key.
- laptop daemon log: 1 lost connection(s), 1 (re)connect(s).

Session `asker` on devcontainer: 108s, 6 turns, exit 0, counterpart server connected. Tool calls: counterpart_open_thread, counterpart_say, counterpart_follow, counterpart_wait_for_reply, counterpart_unfollow.

> - **Limit:** stockroom allows 600 requests per minute per API key, counted per clock minute.
> - **Over it:** you get HTTP 429 (`rate_limited`) with a `Retry-After` header in seconds. Retrying before that time extends the wait. Their reply didn't mention any longer-term blocking of a key.

## 05b-network-drop-message: As 05, with a prompt that says to send a message, since in 05 the agent twice put the question in the thread goal and the front desk never answered

`scripts/devices/scenarios/05b-network-drop-message.json`. Ended as expected.

Faults: disconnect devcontainer at 11.6s; connect devcontainer at 71.9s.

- Waited for the question, as a message, on the laptop: arrived after 7.7s.
- Waited for the laptop's answer on the devcontainer: arrived after 0.6s.
- Check the answer names the header and the 401: pass. 1 message(s); first: Auth is a request header named X-Api-Key, sent on every request. [README.md:5 "Every request needs the header"] The excerpts show the key being read only from that header, with no scheme prefix such as Bearer. [server.js:16 "const key = req.headers"] A missing or unknown key get
- Check the asker's report to its human has the answer: pass. The warehouse agent answered. I didn't edit any files.  **What to put in sync.js** - Send the header `X-Api-Key: <key>` on every request. - Send the key as-is, with no `Bearer` or other prefix. - A missing or unknown key gets HTTP 401 with a body like `{"error":{"code":"unauthorized","message":"send
- devcontainer daemon log: 1 lost connection(s), 1 (re)connect(s).
- after the scenario the rig restarted devcontainer's daemon: it had moved to a new address and was not restarted since

Session `asker` on devcontainer: 203s, 6 turns, exit 0, counterpart server connected. Tool calls: counterpart_open_thread, counterpart_say, counterpart_follow, counterpart_wait_for_reply, counterpart_unfollow.

> The warehouse agent answered. I didn't edit any files.
> 
> **What to put in sync.js**
> - Send the header `X-Api-Key: <key>` on every request.
> - Send the key as-is, with no `Bearer` or other prefix.
> - A missing or unknown key gets HTTP 401 with a body like `{"error":{"code":"unauthorized","message":"send X-Api-Key"}}`.
> - Check for `status === 401` and `error.code === "unauthorized"`. Don't match on `message`, because they say it isn't stable. Error codes are stable.
> - Keys are limited to 600 requests a minute per key. Past that you get 429 with a `Retry-After` header in seconds, so sync.js should wait that long and retry.
> 
> For example:
> 
> ```js
> const res = await fetch(url, { headers: { "X-Api-Key": process.env.STOCKROOM_API_KEY } });
> if (res.status === 401) throw new Error("stockroom auth failed");

## 06t-tunnel-restart-move: Tunnel only: the relay restarts at a new public address while the front desk is answering; both people add the new address, as docs/connectivity.md says

`scripts/devices/scenarios/06t-tunnel-restart-move.json`. Ended as expected.

Faults: relay_restart at 13s.

- Waited for the question, as a message, on the laptop: arrived after 6.7s.
- Waited for the laptop's answer on the devcontainer: arrived after 8.6s.
- Check the answer names 50 and 15 minutes: pass. 1 message(s); first: Default page_size is 50, and it accepts 1 to 200. [README.md:11 "1 to 200, default 50"] Anything above 200 is refused with 400 page_size_too_large, not clamped. [README.md:11 "It is not clamped"] A cursor expires after 15 minutes. [README.md:12 "Cursors expire after 15 minutes"]
- Check the asker's report to its human has the answer: pass. - Default `page_size` is 50 (allowed range 1–200; anything above 200 gets a 400 `page_size_too_large` rather than being clamped). - A cursor expires after 15 minutes. It is the previous page's `next_cursor`, which is `null` on the last page.  I didn't edit any files.
- Human step at 33.2s: laptop: cpart relay add wss://wolf-intensity-korean-compact.trycloudflare.com. Why: the relay came back at a new address; the person sees it and adds it
- Human step at 34.6s: devcontainer: cpart relay add wss://wolf-intensity-korean-compact.trycloudflare.com. Why: told the new address out of band, the person adds it
- Human step at 49.3s: laptop: cpart relay remove wss://wrist-handbags-able-regularly.trycloudflare.com --yes. Why: drop the dead address
- Human step at 49.9s: devcontainer: cpart relay remove wss://wrist-handbags-able-regularly.trycloudflare.com --yes. Why: drop the dead address
- laptop daemon log: 1 lost connection(s), 1 (re)connect(s).
- devcontainer daemon log: 1 lost connection(s), 1 (re)connect(s).
- The relay came back at wss://wolf-intensity-korean-compact.trycloudflare.com; the devices knew it as wss://wrist-handbags-able-regularly.trycloudflare.com.
- laptop: cpart relay add wss://wolf-intensity-korean-compact.trycloudflare.com exited 0 after 1.7s: Added wss://wolf-intensity-korean-compact.trycloudflare.com. Your daemon connects to it and tells your contacts.
- devcontainer: cpart relay add wss://wolf-intensity-korean-compact.trycloudflare.com exited 0 after 1.3s: Added wss://wolf-intensity-korean-compact.trycloudflare.com. Your daemon connects to it and tells your contacts.
- laptop: cpart relay remove wss://wrist-handbags-able-regularly.trycloudflare.com --yes exited 1 after 0.7s: cpart: wss://wrist-handbags-able-regularly.trycloudflare.com is your home relay. Move to another first: cpart relay move <url>
- devcontainer: cpart relay remove wss://wrist-handbags-able-regularly.trycloudflare.com --yes exited 1 after 0.6s: cpart: wss://wrist-handbags-able-regularly.trycloudflare.com is your home relay. Move to another first: cpart relay move <url>
- devcontainer: cpart relay list exited 0 after 1s: Your relays (contacts try them in this order): home wss://wrist-handbags-able-regularly.trycloudflare.com not connected: connection closed wss://wolf-intensity-korean-compact.trycloudflare.com connected Contacts: laptop reach them on wss://wrist-handbags-able-regularly.trycloudflare.com, wss://wolf-intensity-korean-compact.trycloudflare.com has your current list

Session `asker` on devcontainer: 46s, 6 turns, exit 0, counterpart server connected. Tool calls: counterpart_open_thread, counterpart_say, counterpart_follow, counterpart_wait_for_reply, counterpart_unfollow.

> - Default `page_size` is 50 (allowed range 1–200; anything above 200 gets a 400 `page_size_too_large` rather than being clamped).
> - A cursor expires after 15 minutes. It is the previous page's `next_cursor`, which is `null` on the last page.
> 
> I didn't edit any files.

## 06b-relay-restart-message: As 06, with a prompt that says to send a message, since in 06 the agent put the question in the thread goal and the front desk answers only messages

`scripts/devices/scenarios/06b-relay-restart-message.json`. **Did not end as expected.** the laptop's answer on the devcontainer: nothing after 480s

Faults: relay_restart at 11.1s.

- Waited for the question, as a message, on the laptop: arrived after 6.5s.
- Waited for the laptop's answer on the devcontainer: never arrived, after the rig restarted the daemons.
- **Restart by hand** at 340.3s: cpart down, then cpart up, on devcontainer. Why: the laptop's answer on the devcontainer had not arrived 300s after the wait began; devcontainer's cpart status said the daemon was running, not connected
- **Restart by hand** at 584.8s: cpart down, then cpart up, on laptop. Why: laptop's daemon was not running and connected 60s after the scenario's last step; laptop's cpart status said the daemon was running, not connected
- **Restart by hand** at 657.4s: cpart down, then cpart up, on devcontainer. Why: devcontainer's daemon was not running and connected 60s after the scenario's last step; devcontainer's cpart status said the daemon was running, not connected
- laptop daemon log: 1 lost connection(s), 0 (re)connect(s).
- devcontainer daemon log: 1 lost connection(s), 0 (re)connect(s).
- Not delivered: laptop: talk.posted XqAex9FS4B (queued).
- The relay came back at wss://awarded-bestsellers-beautifully-boring.trycloudflare.com; the devices knew it as wss://wolf-intensity-korean-compact.trycloudflare.com.

Session `asker` on devcontainer: 511s, ? turns, exit 143 (error), counterpart server connected. Tool calls: counterpart_open_thread, counterpart_say, counterpart_wait_for_reply, counterpart_wait_for_reply, counterpart_follow, counterpart_wait_for_reply, counterpart_wait_for_reply, counterpart_wait_for_reply. Tool errors: Connection closed.

> Still waiting on laptop's agent to reply about page_size and cursor lifetime; checking again.

