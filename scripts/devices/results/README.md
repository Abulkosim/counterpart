# Results

Each folder is one run of `rig.sh`: `report.md` to read, `results.json` with everything measured. Built and run against `main` as of 2026-11-17 (setup, join with the long invite, invite, status). Two containers on one Linux host; nothing here ran on macOS.

| Run | Relay | Scenarios |
| --- | --- | --- |
| `20261117-container` | container on the devices' network (the host firewall blocks `host`) | 00 to 06 |
| `20261117-container-b` | container | 05b, and 06 again |
| `20261117-container-long` | container | 07, no model |
| `20261117-tunnel` | `cpart relay --tunnel` on the host | 01, 04, 05b, 06 |

## What worked with no help

- Asking (01): the devcontainer's agent asked, the laptop's front desk answered from the README and `server.js`, and the agent told its human what to change. First answer 9 to 13 seconds. Both bugs in `sync.js` found. Same over the tunnel.
- Negotiating (02): two live sessions, one proposal, accepted as it stood by the other side's agent, both humans approved. Agreement 41 seconds after the thread opened. The two approvals were the only human steps.
- The laptop offline for two minutes, back at the same address (03): the answer arrived 122 seconds after the question, with nobody touching anything.
- The laptop asleep for 90 seconds while its front desk was answering (04): answered 95 seconds after the question, 5 seconds after it woke. Same over the tunnel (105 seconds).
- The relay restarting on the same address and database (06, container): both daemons reconnected and the answer arrived. Nothing lost.

## What failed

1. **After a network drop that ends at a new address, nothing arrives until someone restarts the daemon.** The daemon keeps its old connection and never finds out it is dead: the client sends no pings and the relay sends none either. `cpart status` says "running, connected" the whole time. Seen in 00 (both directions), 05b (container and tunnel) and 07. In 07, with nobody restarting anything, a message sent to the laptop after it came back arrived 26 minutes later, and only because the laptop had something of its own to send: about 16 minutes after that send, the kernel gave up on the dead connection and the daemon reconnected. A drop that ends at the same address recovered by itself (00, 03).
2. **When that happens, the asking agent tells its human the wrong thing.** In 05b the reply was waiting at the relay; the agent waited four minutes, then said the other side "may be offline". It cannot tell "not answered" from "not delivered to me".
3. **A question put only in the thread goal is never answered.** In 05 the agent opened a thread whose goal was the whole question and sent no message. The front desk answers only messages, so it never replied, and the agent waited eight minutes for nothing. In 06 (`20261117-container`) the same happened first; the agent sent a message after four minutes and was answered in seconds. Two of the eleven asking sessions kept here did this. 05 also did it in an earlier run whose results were replaced after a rig fix. That 06 row says 6.2 seconds to first answer because it was measured before the clock started at the thread goal; its wait line shows the real 235 seconds.
4. **A tunnel relay that restarts is gone for good.** The quick tunnel came back at a new address (06, tunnel). Both identities still name the old one, and an identity belongs to one relay, so one message stayed queued and nothing a person can do with `cpart up` fixes it.
5. **The relay has to be told the address the devices use.** Without `--url`, the relay names itself after the address it listens on and refuses every login with `wrong_relay_url`. `cpart setup` and `cpart join` still finished; the pairing never completed. This rig passes `--url`. Not run on a Mac: if the Mac side uses `ws://127.0.0.1:7447` and the dev container uses `ws://host.docker.internal:7447`, the relay accepts only one of the two, and the invite carries the Mac side's address.
6. **Setup needs a person to type `yes` once on the joining side** when the relay is on a private address, which a relay on the Mac always is for its dev container. Over the tunnel it did not.

## What was not tested

- macOS, Docker Desktop, and `host.docker.internal` as Docker Desktop provides it.
- `--mode host`: this host's firewall (ufw, default deny incoming) drops traffic from Docker bridges, so the rig fell back to a relay container. The rig does not change the firewall.
- A device that restarts. In a container nothing starts the daemon again (no systemd or launchd); `cpart mcp` starts one when a session opens. Not run.
- Codex. The devices have only Claude Code.
- Each scenario ran once or twice. Model behaviour varies from run to run.
