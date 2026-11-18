# Running a relay

Two people need one relay both can reach. The relay stores sealed messages until the recipient connects. It cannot read them, and it cannot forge them. It does know which device writes to which.

An identity can use several relays and move between them with `cpart relay move`, without pairing again ([connectivity.md](connectivity.md)). A move needs a way to reach your contacts, so an address you can keep is still the easy path.

## To try it with someone today

```sh
cpart relay --tunnel
```

This starts a relay on your machine and asks `cloudflared` for a public address (no account needed). It prints the address and the two commands to run next. The address lasts until you stop the process, and the next start gets a different one. Use it to try Counterpart, not to keep it.

## To keep

Run the container anywhere that gives you a stable name and TLS:

```sh
docker build -t counterpart .
docker run -d --restart unless-stopped -p 8080:8080 -v cpart-relay:/data \
  -e CPART_RELAY_URL=wss://relay.example.com counterpart
```

`CPART_RELAY_URL` is the address people will type. The relay refuses logins that name any other address, so it must match. If people reach it by more than one address, list them all, separated by commas (or give `--url` once for each). When a relay refuses the login this way, `cpart setup` and `cpart join` stop with `wrong_relay_url` and say which address to add; an identity they had just made is not kept. The container speaks plain WebSocket on port 8080; put a proxy that terminates TLS in front of it (Caddy, nginx, a platform's own). `/healthz` answers `{"ok":true,"id":...}` for health checks; `id` is random and kept in the database, so it changes only when the database does. All state is one SQLite file in `/data`.

Without Docker it is the same program:

```sh
cpart relay --host 0.0.0.0 --port 8080 --db /var/lib/cpart/relay.db --url wss://relay.example.com
```

## What has been run

`scripts/two-machines.sh` runs a relay behind a quick tunnel, one person on the host and one in a container that reaches the relay only through the public address. They pair, talk and sign an agreement. The container image has also been run as the relay, restarted, and reconnected to. A relay on a hosting platform has not been run yet.
