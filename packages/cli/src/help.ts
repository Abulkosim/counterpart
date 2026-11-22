// `cpart <command> --help` and `cpart help <command>`: the help for one
// command, not the whole list. The commands a new person starts with have
// their own text; the rest are cut out of the full usage.
import { GUARD_USAGE } from "./guard-cli.ts";
import { RELAY_USAGE } from "./relays.ts";

const NO_AGENTS = `  --no-agents      do not touch Claude Code or Codex: no MCP server, no hooks
  --no-hooks       add the MCP server, but not the hooks that tell a live session a reply arrived
  --no-passphrase  make the identity without a passphrase. It can talk, but cannot approve
                   contracts, release held messages or turn the guard off
  --no-boot        do not start the daemon at login. It still runs until this machine restarts
  --json           machine output`;

const HOME = "Your identity lives in $CPART_HOME (default ~/.counterpart).";

const OWN: Record<string, string> = {
  setup: `cpart setup --relay <ws(s)://host> [--no-agents] [--no-hooks] [--no-passphrase] [--no-boot]

Create your identity, keep the daemon running in the background, and give
Claude Code and Codex the counterpart tools. Safe to run again: each step
already done is skipped, and --relay is needed only the first time.

  --relay <url>    the relay both of you use. Also read from CPART_RELAY
${NO_AGENTS}

You choose a passphrase the first time. You type it to approve a contract,
release or drop a held message, share files with a contact, turn the guard
off and renew this device.

No relay yet? Run one on this machine: cpart relay --boot (see cpart relay --help).
${HOME}`,

  join: `cpart join <code> <what you call them> [--yes] [--no-agents] [--no-hooks] [--no-passphrase] [--no-boot]

Pair with the person who sent you the code, like 7-cider-otter@wss://relay.example.com.
If this machine has no identity yet, join first does what cpart setup does,
on the relay the code names. A long cpart-invite: string works in place of the code.

  --yes            use a relay on your own machine or network without asking. join asks
                   first, because someone outside your network would not send one, and
                   asking needs a terminal. A container on the relay's machine needs this
${NO_AGENTS}

${HOME}`,

  invite: `cpart invite <what you call them> [--no-wait] [--long] [--json [--code]]

Make a short code for one person, print the line to send them, and wait
until they join. The code works once, for a limited time.

  --no-wait        print the code and return. Your daemon still finishes the pairing
  --long           make a long cpart-invite: string instead, good for 24 hours
  --json           machine output. Prints the long invite unless --code is given

cpart status shows codes that are still waiting.`,

  relay: `cpart relay [--port 7447] [--host 127.0.0.1] [--db <file>] [--url <ws(s)://address>]... [--tunnel]
cpart relay --boot [--port 7447] [--host 127.0.0.1] [--db <file>] [--url <address>]...
cpart relay --no-boot [--port <port>]

Run a relay: the server both sides connect to. It keeps sealed messages
until the recipient connects, and cannot read them. Without --boot it runs
in this terminal until you stop it.

  --port <n>       the port to listen on. Default 7447, or $PORT
  --host <addr>    the address to listen on. Default 127.0.0.1, this machine only
  --db <file>      where queued messages are kept. Default ~/.counterpart-relay/relay-<port>.db
                   ($CPART_RELAY_HOME instead of ~/.counterpart-relay if set)
  --url <addr>     an address people use to reach it. Give it once for each. Without it, a relay
                   on 127.0.0.1 answers to this machine's own names and to ws://host.docker.internal,
                   the name a container uses for this machine. Also read from CPART_RELAY_URL
  --tunnel         also get a public address from cloudflared, to try it with someone. The
                   address changes every start, so it does not go with --boot
  --boot           run it in the background: it starts at login and restarts if it stops
                   (a systemd user unit on Linux; a launchd agent on a Mac, not yet tested there).
                   Run it again to change flags
  --no-boot        stop that background relay and stop starting it at login. The database is kept

cpart status says when a relay service is installed here.

The relays your identity uses (not the server):
${RELAY_USAGE}`,

  up: `cpart up [--boot]

Start the background daemon for your identity, if it is not running. It
carries your messages to and from the relay.

  --boot           also start it at login and restart it if it stops

Stop it with: cpart down`,

  down: `cpart down

Stop the background daemon, and stop starting it at login. Nothing is sent
or received until you run cpart up or cpart setup again.`,

  status: `cpart status [--json]

Whether the daemon runs and is connected, which coding agents have the
tools, your contacts, and what is waiting for you. Also says when a relay
service is installed on this machine.`,
};

// The lines of the full usage for one command, with the lines that continue them.
function cut(usage: string, cmd: string): string | undefined {
  const lines = usage.split("\n");
  const picked: string[] = [];
  let taking = false;
  const starts = new RegExp(`^  cpart ${cmd.replace(/[^a-z-]/g, "")}( |$)`);
  for (const l of lines) {
    if (starts.test(l)) {
      taking = true;
      picked.push(l);
    } else if (taking && /^ {40,}\S/.test(l)) picked.push(l);
    else taking = false;
  }
  return picked.length ? picked.join("\n") : undefined;
}

export function commandHelp(cmd: string, usage: string): string | undefined {
  // The guard's commands only make sense together.
  if (["held", "release", "drop", "guard"].includes(cmd)) return GUARD_USAGE;
  const own = OWN[cmd];
  if (own) return own;
  const lines = cut(usage, cmd);
  return lines ? `${lines}\n\nAll commands: cpart help` : undefined;
}
