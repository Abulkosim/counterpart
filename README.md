# Counterpart

Counterpart lets your AI agent talk to someone else's AI agent on another machine.

You tell Claude Code or Codex "agree on the page size with Maya's agent", and it does, without you copying messages between chat windows. The agents talk through a relay that cannot read what they say. The other side's messages are treated as untrusted input: code, not a model, decides what they can do, and only you can approve an agreement.

## Use it

Needs Node 24 or newer. Each person installs it once:

```sh
npm install -g @abulkosim/counterpart
```

If npm's global folder needs root, `curl -fsSL https://raw.githubusercontent.com/Abulkosim/counterpart/main/install.sh | sh` installs under `~/.local` instead. From a checkout, `./install.sh` puts that checkout on your PATH.

You both need a relay you can reach. To try it, one of you runs one with a public address (needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)); it prints its address:

```sh
cpart relay --tunnel
```

To run one without cloudflared, or one that keeps its address, see [docs/relay.md](docs/relay.md).

Sam sets up and invites Maya. `cpart setup` creates an identity, asks for a passphrase, starts a background daemon and adds Counterpart to Claude Code and Codex:

```sh
cpart setup --relay wss://<the address it printed>
cpart invite maya        # prints a short code and the line to send Maya, then waits
```

Maya runs the line Sam sent. It is her whole setup, and it pairs them:

```sh
cpart join 93-help-squad@<relay address> sam     # sam is what Maya calls Sam
```

Then Sam opens Claude Code in his repo and says:

> Ask Maya's agent what their orders API returns for an empty page, and agree on a page size.

His agent opens a thread with Maya. Her side sees it in `cpart status` and in her next session. When she or her agent replies, Sam's session is told that something arrived and reads the reply through its tools.

That is the whole loop. Beyond it, your agent can [answer a contact from your repository](docs/front-desk.md) while you are away, and two people can [sign an agreement and turn it into a pull request](docs/design.md#from-agreement-to-pull-request) that CI checks. `cpart --help` lists every command, and [docs/README.md](docs/README.md) lists every page.

## How it stays safe

- The relay sees only ciphertext. Each person's daemon holds their keys; messages are signed and encrypted end to end ([design](docs/design.md)).
- The pairing code proves who is on each side. A relay that cheats can make pairing fail, never succeed ([pairing](docs/pairing.md)).
- The other side's words reach your agent only when it asks, wrapped and marked as untrusted. A notice that something arrived never carries their text ([MCP and hooks](docs/mcp.md)).
- By themselves, their messages cannot run anything, write a file or grant anything. Your agent can propose an agreement; only you can approve one, with your passphrase, at a terminal.
- Before anything leaves, code checks it for secrets: keys of known shapes, values from your environment and `.env` files, files you marked never-share. A message carrying one is held until you release it ([guard](docs/guard.md)).

## A Mac and a dev container

A project on your Mac and one in a dev container on the same Mac can pair through a relay on the Mac, with no tunnel. [docs/connectivity.md](docs/connectivity.md#a-mac-and-a-dev-container-on-the-same-mac) has the four commands. This has run with Linux containers only, not on a Mac or with Docker Desktop. `./scripts/mac-check.sh` checks it on a real Mac and prints a report.

## Check it yourself

Do not take this page's word for any of it. [docs/verification.md](docs/verification.md) lists every run so far: what ran, what happened, and what was not checked. The numbers in the docs come from those runs and the result files they name. To run the core of it yourself:

```sh
git clone https://github.com/Abulkosim/counterpart && cd counterpart
pnpm install
pnpm verify            # types and tests, including 144 attacks on the code
./scripts/smoke.sh     # a relay and two people as real processes
```

The attacks and how each ended are in [docs/gauntlet.md](docs/gauntlet.md). Each script in `scripts/` says at the top what it checks, what it needs and what it costs. A few use real models.

## Limits

- Experimental. The cryptography has had no outside review, and there is no forward secrecy. Do not rely on it for secrets yet.
- A coding session that reads the other side's text can still be talked into misusing its own shell. Nothing in code stops that. Keep permission prompts on.
- The guard catches what it can recognise. A secret it does not know, or an agent that sends it some other way (curl), gets through.
- One device per person. Nobody hosts a relay for you.
- It has run on Linux only. Nothing has run on macOS or Windows.

The full list is in [docs/verification.md](docs/verification.md#known-limits). To report a security problem, see [SECURITY.md](SECURITY.md).

## License

[Apache 2.0](LICENSE).
