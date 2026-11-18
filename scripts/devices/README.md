# Two devices

A repeatable stand-in for two machines whose agents talk through Counterpart. It runs on one Linux host with Docker.

It stands in for two setups:

- One person with a project on their Mac and another project in a dev container on the same Mac.
- Two people, each on their own laptop.

Both are played by two containers, `laptop` and `devcontainer`. Each has its own disk, its own network namespace, its own `CPART_HOME`, its own checkout of Counterpart installed with `install.sh`, Claude Code logged in, and its own small repository:

- `laptop` holds `stockroom`, a tiny HTTP API with a README (`repos/provider`).
- `devcontainer` holds `shelf-sync`, a client of that API with two bugs in how it pages (`repos/client`).

Nothing here runs on macOS. What it shows about a Mac is what it shows about any machine that sleeps, loses its network, or talks to a relay that restarts. Docker Desktop's own networking is not exercised.

## Run it

```sh
./scripts/devices/rig.sh --no-sessions        # no model, no cost: 00-plumbing, about ten minutes
./scripts/devices/rig.sh                      # every scenario except the long one. Uses real models, about 40 minutes
./scripts/devices/rig.sh --mode tunnel        # the relay behind cpart relay --tunnel. Needs cloudflared
./scripts/devices/rig.sh scripts/devices/scenarios/01-ask.json      # one scenario
./scripts/devices/rig.sh --no-sessions scripts/devices/scenarios/07-drop-no-restart.json   # the long one, up to 30 minutes
./scripts/devices/rig.sh --mode mac scripts/devices/scenarios/11-mac-naming.json          # the relay named as on a Mac and its dev container
```

`--long` pairs with the long invite instead of a short code. `--prefix NAME` starts the names of the containers, the network and the image with `NAME` (default `two-devices`), for a shared machine where names must say whose they are.

Needs Docker. Scenarios with live sessions need a Claude Code login on this machine (`~/.claude/.credentials.json`).

Each run writes `results.json` and `report.md` to `scripts/devices/results/<date>-<mode>/` (or `--out`). Session transcripts and daemon logs go to `logs/` beside them and are not committed: transcripts list the connectors of the account that ran them.

## The relay

`--mode` picks where it runs:

- `host`: a `cpart relay` process on this machine, bound to Docker's bridge address. The devices reach it as `host.docker.internal`, mapped with `--add-host host.docker.internal:host-gateway`. This is the human's own case, a relay on the Mac that the dev container reaches.
- `container`: a third container on the devices' network, reached by the same name, `host.docker.internal`. A fourth container is a spare relay, `ws://relay-b:7447`, that scenarios can add with `cpart relay add {{spare}}`.
- `tunnel`: a `cpart relay --tunnel` process on this machine. The devices reach it over the internet, through Cloudflare.
- `mac`: the relay runs in a container that shares the laptop's network namespace (`--network container:<laptop>`), with no `--url`, listening on `0.0.0.0:7447`. The laptop dials it as `ws://127.0.0.1:7447`. The laptop has the network alias `host.docker.internal`, so the devcontainer dials `ws://host.docker.internal:7447`. These are the names a Mac and a dev container on it use. What this does not reproduce: macOS, Docker Desktop's VM and how it forwards `host.docker.internal` to the Mac, and a relay that listens on 127.0.0.1 only. On a Mac a network drop does not cut the dev container off from the Mac; here a `disconnect` of the laptop also takes the relay off the network.
- `auto` (the default): `host` if a device can reach it, otherwise `container`.

On the machine this was built on, `host` does not work: the firewall (ufw, default deny incoming) drops traffic from Docker bridges to the host. The rig says so and falls back to `container`. To use `host`, allow the port from `docker0`, for example `sudo ufw allow in on docker0 to 172.17.0.1 port <port> proto tcp`. The rig does not change the firewall.

The relay is started with `--url` set to the address the devices use, except in `mac` mode. With no `--url`, a relay listening on `0.0.0.0` answers to the loopback names and `host.docker.internal`, and nothing else.

## Pairing

Before any scenario, the way a person now would: `cpart setup --relay <url>` on the laptop, then `cpart invite devcontainer` there. It prints a short code and the line to send, and waits; the rig runs it in the background and reads the line. The devcontainer runs that line, `cpart join <code>@<relay> laptop`. A relay on a private address makes `join` ask first; the rig tries without `--yes`, and when `join` says it needs a terminal, records a human step and runs it again with `--yes`. `--long` uses `cpart invite devcontainer --long` and the `cpart-invite:` string instead.

`cpart join` makes the devcontainer's identity and registers Counterpart with Claude Code inside that device. Each device has its own Claude Code config directory, so nothing on the machine running the rig is touched.

## Faults

- Sleep: `docker pause`, then `docker unpause`. Every process in the device stops, as on a closed laptop.
- Wi-Fi drop: `docker network disconnect`, then `docker network connect`. By default the device comes back at a new address, as a laptop often does on a new network. `"same_address": true` brings it back at the old one.
- Relay restart: the relay process or container stops and starts again on the same database. With `--mode tunnel` it comes back at a new public address.
- Relay gone: `relay_stop` with `"hard": true` kills it (SIGKILL, `docker kill`). `"relay": "spare"` acts on the spare relay instead of the home one. A stopped relay is started again only after the scenario.

## What is measured

For each scenario:

- Time to first answer: from the asker's first message or the goal of the thread it opened, whichever came first, to the first reply in that thread. Both are read from the asker's own store and clock. Results committed before 2026-11-18 may have counted from the first message only; `results/README.md` says which.
- Time to agreement: from the thread opening to the second approval, read from the laptop's store.
- Human steps: approvals, typing `yes` during setup, and any restart by hand. Approvals are meant to be human; restarts are not.
- Messages lost: messages one store holds as its own that the other store never applied, after up to 90 seconds to settle. Held messages (waiting for an earlier one) are counted beside them.
- Restarted by hand: a wait can say `recover_after`. When the message has not arrived by then, the rig does what a person would do, `cpart down` and `cpart up` on the waiting device, records it, and keeps waiting. It also records what `cpart status` said just before, since that is what the person would have looked at.

A scenario is `ok` only if every step ran, every check passed, nothing was lost, and nothing was restarted by hand.

`rig.sh` exits 0 when every scenario was `ok`, 3 when the run finished but one or more were not, and 130 when stopped by a signal.

Between scenarios the rig undoes what a scenario left behind: it wakes a sleeping device and puts an offline one back at its old address. A device left at a new address gets its daemon restarted, since its link may be dead while `cpart status` says connected. That restart is noted in the results; it is not counted against the next scenario.

## Safety on a shared machine

- The login is copied into the run's work directory with mode 600, without its refresh token, mounted read-only into both devices, and deleted when the run ends, however it ends (a `kill -9` of `rig.sh` is the exception). A refresh from inside a device would rotate the refresh token and end the login on this machine; without it, a device can only use the access token until it expires. The rig refuses to start with less than 30 minutes left on it, and starts no session that would outlast it.
- `ENABLE_CLAUDEAI_MCP_SERVERS=false` keeps the account's own connectors out of the devices' sessions. Each session gets the Counterpart tools and `Read`, `Grep`, `Glob`. Only the Counterpart tools are in `--allowedTools`, so the built-in ones keep the default scope of `claude -p`: the session's own repository. Reads of the login, `~/.cpart`, the Counterpart checkout and `/proc` are also denied outright. A run checked this: with `Read` listed bare in `--allowedTools`, a session could read any file in the device, the login included.
- The approval passphrases are new for each run and stay on this machine. The rig is left out of the device image. After pairing, both daemons are started again without `CPART_PASSPHRASE`, since `cpart setup` and `cpart join` pass their environment to the daemon they start.
- Containers and the network are named `<prefix>-<run>-...` (`two-devices` unless `--prefix` says otherwise) and removed at the end. The image is kept, so the next run builds from cache; remove it with `docker rmi <prefix>:latest`.
- The guard scenario plants a fake key, new for each run, in the devcontainer's repository. It is not a real credential. The rig reads the relays' database files from this machine to check the key is not there.
- `cpart release` runs on a pseudo-terminal made with `python3` on this machine (`docker exec -it` inside it), and the rig types the passphrase at the prompt. The passphrase goes through the environment of that one process, never its arguments. In `container` mode no port is opened on the host. `host` and `tunnel` modes take a free port.
- Devices never touch this machine's `~/.counterpart`, `~/.claude` settings or `~/.codex`. `CPART_NO_BOOT=1` is set inside them.

## Scenario files

One JSON file per case in `scenarios/`, run in name order. A scenario with `"long": true` runs only when named.

```json
{
  "name": "04-sleep",
  "title": "What it shows, in one line",
  "asker": "devcontainer",
  "sessions": true,
  "needs": ["container", "host"],
  "steps": [ { "do": "...", ... } ]
}
```

`asker` is the device whose first message starts the clock for time to first answer. `sessions: false` marks a scenario that uses no model; only those run with `--no-sessions`. `needs` limits it to some relay modes.

Steps run in order. `{{name}}` in a prompt, argument, pattern or file is replaced by a value a `capture` or `approve` step saved, or one the rig sets: `{{relay}}` and `{{spare}}` (the relays' addresses), `{{secret}}` (a fake live key, new each run), `{{secret_tail}}` (its last 12 characters) and `{{sandbox}}` (a harmless id the owner is willing to share).

| `do` | Fields | What it does |
| --- | --- | --- |
| `desk` | `device`, `files`, `as`, `slots`, `on`, `via` | Shares files from the device's repo with the other device (`cpart share --repo`, or copies with `"via": "bundle"`) and turns the front desk on. `"on": false` turns it off |
| `write` | `device`, `path`, `content` | Writes a file into the device's repository, not committed |
| `release` | `device`, `text`, `why`, `required` | The owner releases the newest message held in this scenario whose preview matches `text`: `cpart release` on a pseudo-terminal, passphrase typed at the prompt. A human step |
| `wait_relays` | `device`, `contact`, `their_relays`, `confirmed`, `timeout`, `label` | Waits until `cpart relay list` on the device shows the contact on `their_relays`, and with `"confirmed": true` that the contact has confirmed this device's list |
| `session` | `device`, `id`, `prompt`, `tools`, `timeout`, `background` | Runs `claude -p` in the device's repo with the Counterpart tools `cpart setup` registered, plus the listed built-in tools. In the background, the next steps run while it does |
| `await` | `id` | Waits for a background session to end |
| `capture` | `device`, `var` | Saves the id of the newest thread this scenario made on the device as `{{var}}` (default `thread`) |
| `wait_message` | `device`, `type`, `text`, `since`, `timeout`, `recover_after`, `restart`, `required`, `label` | Waits until the device's store has an event of `type` (default `talk.posted`) from the other device, in a thread made during this scenario, matching the regular expression `text`. `"since": "step"` counts only what arrives after the step starts. See `recover_after` above; `restart` names the device to restart, if not the waiting one. `"required": false` records a timeout instead of failing |
| `fault` | `kind`, `device`, `same_address`, `down_seconds`, `relay`, `hard` | `pause`, `unpause`, `disconnect`, `connect`, `relay_stop`, `relay_start`, `relay_restart`, `daemon_down`. See Faults |
| `sleep` | `seconds` | |
| `cpart` | `device`, `args`, `passphrase`, `human`, `why`, `may_fail`, `timeout`, `cwd`, `record` | Runs `cpart` in the device. `passphrase` sets `CPART_PASSPHRASE` for this command only. `human` counts it as a human step. `"cwd": "repo"` runs it in the device's repository, which is what the guard reads `.env` files from. `record` puts what it printed in the results |
| `approve` | `device`, `thread`, `proposal`, `timeout` | The human approves: `cpart approve --yes` with `CPART_PASSPHRASE`. `proposal` is `latest-open` or an id prefix. Saves the id as `{{proposal}}` |
| `expect` | `check`, `negate`, `info` and one of the kinds below | Records a check. `"negate": true` passes when the kind does not match. A failed check marks the scenario failed but does not stop it; one with `"info": true` is a measurement and never fails it |

Kinds of `expect`:

- `message_matches` (with `device`): all patterns match one message from the other side. `"any_event": true` looks at every event from the other side, whole: thread goals and contracts too.
- `session_matches` (with `session`): all patterns match the session's final report.
- `sent_matches` (with `session`): a pattern matches what the session passed to a Counterpart tool. That is what it tried to send, whether or not the guard let it out.
- `held` (with `device`, `min`, `max`): the number of messages the guard held on the device during the scenario (`cpart held --all`).
- `relay_db_matches`: a pattern is in either relay's database files, as written, in base64 or in hex. Container and mac modes only.
- `cpart_matches` (with `device`, `args`): all patterns match what `cpart <args>` prints.
- `agreed` (with `thread`): both sides hold an agreement.

### Adding to it

A new feature usually needs no new step type, only a new scenario or a changed one. Pairing happens in `setup()` in `run.ts`, before any scenario. Relays: `relay_stop`, `relay add {{spare}}`, `relay move`, `wait_relays` (08, 09). The guard: `write`, a `session` that tempts the agent, `held`, `sent_matches`, `message_matches` with `negate`, `release` (10). Session hooks: a `session` step whose prompt relies on the hook, and a `wait_message` or `expect` on what the hook should have done.

A new step type is a new `case` in `Running.step` in `run.ts`. Keep it to what a person or a machine would do; measure in `measure()`, not in the step.

## Files

- `rig.sh`: builds the image from this checkout, copies the login, runs `run.ts`, cleans up. Sources `scripts/smoke-lib.sh` for the work directory, a free port, and logs on failure.
- `run.ts`: pairing, the scenario runner, the measurements.
- `rig.ts`: Docker, the relay, the faults.
- `report.ts`: `results.json` and `report.md`.
- `Dockerfile`: one device.
- `repos/`: the two seed repositories.
- `results/`: committed results of runs.
