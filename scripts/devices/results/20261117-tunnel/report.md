# Two-device run, 2026-11-17 23:00 UTC

Relay: tunnel, relay process on this machine behind cpart relay --tunnel (cloudflared quick tunnel); the devices reach it over the internet. Model claude-sonnet-5-5, 2.1.326 (Claude Code). Both devices are Docker containers on one Linux host.

Setup: `cpart setup` on the laptop, `cpart join` on the devcontainer, paired in 18s. Safety codes match. Agents: laptop Claude Code: here; devcontainer Claude Code: here.

| Scenario | Result | First answer | Agreement | Human steps | Lost | Restarted by hand | Took |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01-ask | ok | 13.4s | - | 0 | 0 | no | 42s |
| 04-sleep | ok | 105.3s | - | 0 | 0 | no | 132s |
| 05b-network-drop-message | **failed** | 375.5s | - | 1 | 0 | yes | 400s |
| 06-relay-restart | **failed** | none | - | 3 | 1 | yes | 765s |

First answer: from the asker's question to the first reply in the asker's store, both by the asker's clock. Lost: messages one store holds as sent and the other never applied, after up to 90 seconds to settle. Human steps include approvals, which are meant to be human.

## 01-ask: The devcontainer's agent asks a question only the laptop's repo can answer; the laptop's front desk answers

`scripts/devices/scenarios/01-ask.json`. Ended as expected.

- Waited for the laptop's answer on the devcontainer: arrived after 21.1s.
- Check the answer names the 200 limit and the null cursor: pass. 1 message(s); first: (1) stockroom does not honour or clamp page_size=500. It refuses anything above 200 with `400 {"error":{"code":"page_size_too_large"}}`. The maximum is 200, the default is 50, and the minimum is 1. (from README.md; server.js enforces the same with MAX_PAGE = 200)  (2) On the las
- Check the asker's report to its human names both: pass. I asked laptop's agent about the paging and it answered. Here is what to change in `sync.js`. I haven't edited anything.  1. **Page size (line 10):** Stockroom rejects `page_size` above 200 with a `400 page_size_too_large`, so 500 fails on the first request. Use 200 or less. The default is 50. 2. **

Session `asker` on devcontainer: 26s, 7 turns, exit 0, counterpart server connected. Tool calls: Grep, counterpart_contacts, Read, counterpart_open_thread, counterpart_say, counterpart_wait_for_reply.

> I asked laptop's agent about the paging and it answered. Here is what to change in `sync.js`. I haven't edited anything.
> 
> 1. **Page size (line 10):** Stockroom rejects `page_size` above 200 with a `400 page_size_too_large`, so 500 fails on the first request. Use 200 or less. The default is 50.
> 2. **Loop end (line 16):** On the last page `next_cursor` is `null`, never absent. `cursor !== undefined` is therefore always true, and the loop never ends. Use `while (cursor != null)`, or `while (cursor)`. Line 11 already skips a falsy cursor, so `null` isn't sent back.
> 3. **Error handling (after line 12):** There is no check on `res.ok`. A `400`, `401` or `429` currently falls through to `page.items` and crashes. Throw on non-OK responses. On `429`, wait for the `Retry-After` seconds and retry.
> 4. **Cursor expiry:** Cursors expire after 15 minutes, so a very slow sync could lose its place.
> 
> All of this comes from the other agent's reading of their README.md and server.js. I haven't checked it against the API itself.

## 04-sleep: The laptop goes to sleep for 90 seconds just as the question reaches it, while its front desk is writing the answer

`scripts/devices/scenarios/04-sleep.json`. Ended as expected.

Faults: pause laptop at 17.8s; unpause laptop at 108.3s.

- Waited for the question on the laptop: arrived after 6.4s.
- Waited for the laptop's answer on the devcontainer: arrived after 4.9s.
- Check the answer names 600 a minute and the 429: pass. 1 message(s); first: Limit: 600 requests per minute, counted per API key (the material says per key, not per IP). (from README.md)  Going over it: - Status is 429 with the error body shape {"error":{"code":"...","message":"..."}}. (from README.md) - A Retry-After header gives the wait in seconds. Wa
- Check the asker's report to its human has the answer: pass. - **Limit:** 600 requests/minute per API key, counted in fixed clock-minute buckets (not a sliding window). - **Over it:** You get a 429 with `{"error":{"code":"rate_limited",...}}` and a `Retry-After` header, which is the seconds left until the next clock minute. The README says retrying sooner ext

Session `asker` on devcontainer: 116s, 5 turns, exit 0, counterpart server connected. Tool calls: counterpart_contacts, counterpart_open_thread, counterpart_say, counterpart_wait_for_reply.

> - **Limit:** 600 requests/minute per API key, counted in fixed clock-minute buckets (not a sliding window).
> - **Over it:** You get a 429 with `{"error":{"code":"rate_limited",...}}` and a `Retry-After` header, which is the seconds left until the next clock minute. The README says retrying sooner extends the wait, but server.js shows no mechanism for that, and there's no mention of IP limits or longer blocks.

## 05b-network-drop-message: As 05, with a prompt that says to send a message, since in 05 the agent twice put the question in the thread goal and the front desk never answered

`scripts/devices/scenarios/05b-network-drop-message.json`. **Did not end as expected.**

Faults: disconnect devcontainer at 14s; connect devcontainer at 74.5s.

- Waited for the question, as a message, on the laptop: arrived after 7s.
- Waited for the laptop's answer on the devcontainer: arrived after 307.3s, after the rig restarted the daemons.
- Check the answer names the header and the 401: pass. 1 message(s); first: Header name: `X-Api-Key`, required on every request (from README.md). The material describes no scheme or prefix such as `Bearer`. server.js compares the header value as-is against its list of valid keys (from server.js).  Bad or missing key: status `401` with body `{"error":{"c
- Check the asker's report to its human has the answer: **fail**. I've had no answer from the laptop agent yet. I opened thread `lsmk5TdS2UgRW7_OEgYiIg` and asked how sync.js should authenticate (header name, key format, where the key comes from) and what a bad or missing key gets back (status code and body). The relay stored the message. I then waited about 4 min
- **Restart by hand** at 383.2s: cpart down, then cpart up, on devcontainer. Why: the laptop's answer on the devcontainer had not arrived 300s after the wait began; devcontainer's cpart status said the daemon was running and connected
- laptop daemon log: 2 lost connection(s), 2 (re)connect(s).

Session `asker` on devcontainer: 260s, 5 turns, exit 0, counterpart server connected. Tool calls: counterpart_open_thread, counterpart_say, counterpart_wait_for_reply, counterpart_wait_for_reply.

> I've had no answer from the laptop agent yet. I opened thread `lsmk5TdS2UgRW7_OEgYiIg` and asked how sync.js should authenticate (header name, key format, where the key comes from) and what a bad or missing key gets back (status code and body). The relay stored the message. I then waited about 4 minutes in total, across two 2-minute waits, and nothing came back.
> 
> Without their answer I can't tell you what to put in sync.js, and I don't want to guess at an auth scheme. I haven't edited any files.
> 
> The other agent may be offline or slow to respond. I can keep waiting, or you can ask the warehouse team to check that their agent is running. Tell me which you'd like.

## 06-relay-restart: The relay restarts while the laptop's front desk is answering

`scripts/devices/scenarios/06-relay-restart.json`. **Did not end as expected.** the laptop's answer on the devcontainer: nothing after 480s

Faults: relay_restart at 13.1s.

- Waited for the question on the laptop: arrived after 5.6s.
- Waited for the laptop's answer on the devcontainer: never arrived, after the rig restarted the daemons.
- **Restart by hand** at 343.7s: cpart down, then cpart up, on devcontainer. Why: the laptop's answer on the devcontainer had not arrived 300s after the wait began; devcontainer's cpart status said the daemon was running, not connected
- **Restart by hand** at 590.9s: cpart down, then cpart up, on laptop. Why: laptop's daemon was not running and connected 60s after the scenario's last step; laptop's cpart status said the daemon was running, not connected
- **Restart by hand** at 665.8s: cpart down, then cpart up, on devcontainer. Why: devcontainer's daemon was not running and connected 60s after the scenario's last step; devcontainer's cpart status said the daemon was running, not connected
- laptop daemon log: 1 lost connection(s), 0 (re)connect(s).
- devcontainer daemon log: 1 lost connection(s), 0 (re)connect(s).
- Not delivered: laptop: talk.posted FvjjP5SwNP (queued).
- The relay came back at wss://myself-fighters-organ-symantec.trycloudflare.com. Both identities still point at wss://scheme-italic-portable-set.trycloudflare.com, and an identity belongs to one relay.

Session `asker` on devcontainer: 382s, 7 turns, exit 0, counterpart server connected. Tool calls: counterpart_contacts, counterpart_open_thread, counterpart_say, counterpart_wait_for_reply, counterpart_wait_for_reply, counterpart_wait_for_reply.

> No answer yet. I asked laptop's agent in thread `15Yz2RLdOlkQMTus3Tx8sg` for the default page_size and the cursor validity, and waited about 6 minutes with no reply.
> I haven't edited any files. Tell me if you want me to keep waiting or ask again later.

