# Two-device run, 2026-11-17 22:52 UTC

Relay: container, relay in a third container on the devices' network, reached as host.docker.internal. Model claude-sonnet-5-5, 2.1.326 (Claude Code). Both devices are Docker containers on one Linux host.

Setup: `cpart setup` on the laptop, `cpart join` on the devcontainer, paired in 12s. Safety codes match. Agents: laptop Claude Code: here; devcontainer Claude Code: here.
- Human step during setup: devcontainer: typed yes to use a relay on a private address (cpart join ... --yes). join asks before it uses a relay on a private address; without a terminal it said: cpart: this needs a terminal

| Scenario | Result | First answer | Agreement | Human steps | Lost | Restarted by hand | Took |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 05b-network-drop-message | **failed** | 370.5s | - | 1 | 0 | yes | 389s |
| 06-relay-restart | ok | 18.2s | - | 0 | 0 | no | 37s |

First answer: from the asker's question to the first reply in the asker's store, both by the asker's clock. Lost: messages one store holds as sent and the other never applied, after up to 90 seconds to settle. Human steps include approvals, which are meant to be human.

## 05b-network-drop-message: As 05, with a prompt that says to send a message, since in 05 the agent twice put the question in the thread goal and the front desk never answered

`scripts/devices/scenarios/05b-network-drop-message.json`. **Did not end as expected.**

Faults: disconnect devcontainer at 7.8s; connect devcontainer at 67.9s.

- Waited for the question, as a message, on the laptop: arrived after 5.3s.
- Waited for the laptop's answer on the devcontainer: arrived after 307.3s, after the rig restarted the daemons.
- Check the answer names the header and the 401: pass. 1 message(s); first: Authentication: every request must carry the header `X-Api-Key` with the API key as its value. No scheme prefix (like Bearer) is mentioned. (from README.md)  Bad or missing key: the API returns `401` with body `{"error":{"code":"unauthorized"}}`. (from README.md) The server code
- Check the asker's report to its human has the answer: **fail**. I don't have an answer yet. I opened thread `oWBAoiwMrveztty2h-6aRA` with laptop and asked how sync.js should authenticate (header name, scheme, where the key comes from) and what a bad or missing key gets back (status code and body). I then waited about 4 minutes in two 120-second waits, and laptop
- **Restart by hand** at 375.3s: cpart down, then cpart up, on devcontainer. Why: the laptop's answer on the devcontainer had not arrived 300s after the wait began; devcontainer's cpart status said the daemon was running and connected

Session `asker` on devcontainer: 326s, 5 turns, exit 0, counterpart server connected. Tool calls: counterpart_open_thread, counterpart_say, counterpart_wait_for_reply, counterpart_wait_for_reply.

> I don't have an answer yet. I opened thread `oWBAoiwMrveztty2h-6aRA` with laptop and asked how sync.js should authenticate (header name, scheme, where the key comes from) and what a bad or missing key gets back (status code and body). I then waited about 4 minutes in two 120-second waits, and laptop's agent hasn't replied. The relay has stored the messages for them.
> 
> I have nothing to put in sync.js yet. I haven't guessed at a header or error format, and I haven't edited any files.
> 
> If you'd like, I can keep waiting or check the thread again later. You could also ask the warehouse team directly in case their agent is offline.

## 06-relay-restart: The relay restarts while the laptop's front desk is answering

`scripts/devices/scenarios/06-relay-restart.json`. Ended as expected.

Faults: relay_restart at 11.5s.

- Waited for the question on the laptop: arrived after 4.7s.
- Waited for the laptop's answer on the devcontainer: arrived after 1.7s.
- Check the answer names 50 and 15 minutes: pass. 1 message(s); first: 1) The default page_size is 50 (range 1 to 200; anything above 200 is refused with 400 page_size_too_large, not clamped). (from README.md; server.js also uses 50 as the default.)  2) A pagination cursor expires after 15 minutes. (from README.md)  The cursor is the `next_cursor` 
- Check the asker's report to its human has the answer: pass. - Default `page_size` is 50 (range 1–200; above 200 returns 400 `page_size_too_large` rather than being clamped). - A cursor (`next_cursor` from the previous page) expires after 15 minutes. It is `null` on the last page.  This comes from the warehouse agent, who cited their README.md and server.js. 
- laptop daemon log: 1 lost connection(s), 1 (re)connect(s).
- devcontainer daemon log: 1 lost connection(s), 1 (re)connect(s).

Session `asker` on devcontainer: 25s, 5 turns, exit 0, counterpart server connected. Tool calls: counterpart_contacts, counterpart_open_thread, counterpart_say, counterpart_wait_for_reply.

> - Default `page_size` is 50 (range 1–200; above 200 returns 400 `page_size_too_large` rather than being clamped).
> - A cursor (`next_cursor` from the previous page) expires after 15 minutes. It is `null` on the last page.
> 
> This comes from the warehouse agent, who cited their README.md and server.js. I didn't check it against the API itself. I didn't edit any files.

