# Two-device run, 2026-11-17 22:22 UTC

Relay: container, relay in a third container on the devices' network, reached as host.docker.internal. Model claude-sonnet-5-5, 2.1.326 (Claude Code). Both devices are Docker containers on one Linux host.

Setup: `cpart setup` on the laptop, `cpart join` on the devcontainer, paired in 22s. Safety codes match. Agents: laptop Claude Code: here; devcontainer Claude Code: here.
- Human step during setup: devcontainer: typed yes to use a relay on a private address (cpart join ... --yes). join asks before it uses a relay on a private address; without a terminal it said: cpart: this needs a terminal

| Scenario | Result | First answer | Agreement | Human steps | Lost | Restarted by hand | Took |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 07-drop-no-restart | **failed** | 1585.3s | - | 0 | 0 | no | 1602s |

First answer: from the asker's first message (not the thread goal) to the first reply in the asker's store, both by the asker's clock. This run predates counting from the thread goal; see `../README.md`. Lost: messages one store holds as sent and the other never applied, after up to 90 seconds to settle. Human steps include approvals, which are meant to be human.

## 07-drop-no-restart: No model: after a network drop and a new address, does a message ever arrive without a restart? Takes up to 30 minutes

`scripts/devices/scenarios/07-drop-no-restart.json`. **Did not end as expected.**

Faults: disconnect laptop at 5.4s; connect laptop at 25.6s.

- Waited for the first message on the laptop: arrived after 0s.
- Waited for a message sent after the laptop came back, with nobody restarting anything: never arrived.
- Waited for the laptop's own message, once it has something to send: arrived after 960s.
- Waited for the devcontainer's message, after a restart by hand if still needed: arrived after 0s.
- laptop daemon log: 1 lost connection(s), 1 (re)connect(s).

