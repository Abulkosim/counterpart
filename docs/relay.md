# Running a relay

Two people need one relay both can reach. The relay stores sealed messages until the recipient connects. It cannot read them and cannot forge them. It does know which device writes to which. Nobody hosts a public relay for Counterpart: you run one.

An identity can use several relays and move between them with `cpart relay move`, without pairing again ([connectivity.md](connectivity.md)). A move needs a way to reach your contacts, so an address you can keep is still the easy path.

## On your own machine

For two projects on one machine, such as a project on a Mac and another in a dev container on it ([connectivity.md](connectivity.md#a-mac-and-a-dev-container-on-the-same-mac)), run the relay on that machine as a service:

```sh
cpart relay --boot
```

It runs in the background, starts at login and restarts if it stops: a systemd user unit on Linux, a launchd agent on a Mac. It prints the address to use (`ws://127.0.0.1:7447`) and the one a container on the same machine uses (`ws://host.docker.internal:7447`). `cpart status` shows that it is installed and whether it answers. To change its flags, run `cpart relay --boot` again with the new ones; it replaces the service and keeps the database. To stop it and stop starting it at login:

```sh
cpart relay --no-boot
```

The database stays. `--port`, `--host`, `--db` and `--url` work as they do in the foreground. `--tunnel` does not go with `--boot`, because a tunnel's address changes at every start.

On Linux a user service starts when you log in, not when the machine boots. On a server nobody logs in to, run `loginctl enable-linger $USER` once, or use the container below.

### Where the database is

A relay keeps queued messages in `~/.counterpart-relay/relay-<port>.db`, unless `--db` says otherwise. `CPART_RELAY_HOME` changes the folder. The path does not depend on the directory you start the relay from, so it always finds the same queued mail and writes nothing into a project.

The relay belongs to the machine, not to an identity: every identity and every container on the machine can use it, so its folder sits beside `~/.counterpart`, not inside it. Each port has its own file. Two relays must not share a database, because a relay's id lives in it and clients use the id to tell relays apart.

Before v0.3.0 the database was `./relay.db` in whatever directory the relay started from. If `cpart relay` finds one there, it says so. Its queued messages are not moved: run once with `--db relay.db` until contacts have collected them, or move the file and its `-wal` file to the new path while the relay is stopped.

## To try it with someone today

```sh
cpart relay --tunnel
```

This starts a relay and asks `cloudflared` for a public address (no account needed). It prints the address and the two commands to run next. The address lasts until you stop the process, and the next start gets a different one ([connectivity.md](connectivity.md#after-a-tunnel-restart)). Use it to try Counterpart, not to keep it.

## To keep

Run the container anywhere that gives you a stable name and TLS:

```sh
docker build -t counterpart .
docker run -d --restart unless-stopped -p 8080:8080 -v cpart-relay:/data \
  -e CPART_RELAY_URL=wss://relay.example.com counterpart
```

`CPART_RELAY_URL` is the address people will type. The relay refuses logins that name any other address, so it must match. If people reach it by more than one address, list them all, separated by commas. When a relay refuses a login this way, `cpart setup` and `cpart join` stop with `wrong_relay_url` and say which address to add; an identity they had just made is not kept.

The container speaks plain WebSocket on port 8080. Put a proxy that terminates TLS in front of it (Caddy, nginx, a platform's own). `/healthz` answers `{"ok":true,"id":...}` for health checks; `id` is random and kept in the database. All state is one SQLite file in `/data`.

Without Docker it is the same program:

```sh
cpart relay --host 0.0.0.0 --port 8080 --db /var/lib/cpart/relay.db --url wss://relay.example.com
```

## Limits

- Anyone who can reach the relay can make an identity and send to a mailbox. Senders a recipient has never accepted share a small allowance per mailbox ([protocol.md](protocol.md#relay)). A relay that admits only listed root keys exists in code (`allowRoots` in `startRelay`); `cpart relay` has no flag for it yet.
- Short-code nameplates live in memory: a relay restart ends every pairing in progress.
- The relay sees who writes to whom, when, and how much.

## What has been run

- `scripts/relay-service-smoke.sh` runs `cpart relay --boot` under a real systemd user session on Linux: two people pair through the service, a message waits at the relay while its process is killed, systemd starts it again on the same database, and the message is delivered. Then `--no-boot` removes it.
- `scripts/two-machines.sh` runs a relay behind a quick tunnel, one person on the host and one in a container that reaches the relay only through the public address. They pair, talk and sign an agreement. The container image has also been run as the relay, restarted, and reconnected to.
- The launchd agent has not been run: there is no Mac here. Its file is checked as a property list in `packages/cli/test/relay-service.test.ts`.
- A relay on a hosting platform has not been run.

[verification.md](verification.md) has the dates and results.
