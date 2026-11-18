import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRelayUrl, relayKey } from "@counterpart/protocol";

// The addresses a relay answers to. A login names the address the client
// dialled, and the relay accepts it only if that is one of these, so another
// relay cannot pass our challenge to its own clients and log in as them.
//
// One relay often has several names: a laptop reaches it as ws://127.0.0.1:7447
// and a container on the same laptop as ws://host.docker.internal:7447.
export interface RelayNames {
  primary: string; // printed, and the one to put in invites
  all: string[];
  has(url: string): boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::", "[::]"]);

// With no address given, a relay that listens on this machine only (or on every
// interface) answers to the loopback names and to host.docker.internal, the name
// a container uses for the machine it runs on. With addresses given, exactly those.
export function relayNames(host: string, port: number, given: string[]): RelayNames {
  for (const u of given) if (!isRelayUrl(u)) throw new Error(`not a relay address: ${JSON.stringify(u).slice(0, 80)}. Use ws:// or wss://, a host, and an optional port and path`);
  const all = given.length
    ? given
    : LOOPBACK.has(host)
      ? [`ws://127.0.0.1:${port}`, `ws://localhost:${port}`, `ws://[::1]:${port}`, `ws://host.docker.internal:${port}`]
      : [`ws://${host.includes(":") ? `[${host}]` : host}:${port}`];
  const keys = new Set(all.map(relayKey));
  return {
    primary: all[0]!,
    all: [...new Set(all)],
    has: (url) => isRelayUrl(url) && keys.has(relayKey(url)),
  };
}

// CPART_RELAY_URL may hold several addresses, separated by commas or spaces.
export const splitUrls = (s: string | undefined): string[] => (s ?? "").split(/[\s,]+/).filter(Boolean);

// A random id this relay keeps for as long as its database. It is in /healthz
// and the ready frame, so a client that reaches one relay by two names can tell
// they are the same relay and keep one connection to it.
export function relayId(db: DatabaseSync): string {
  db.exec("CREATE TABLE IF NOT EXISTS relay_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  db.prepare("INSERT OR IGNORE INTO relay_meta (k, v) VALUES ('id', ?)").run(randomBytes(16).toString("base64url"));
  return (db.prepare("SELECT v FROM relay_meta WHERE k = 'id'").get() as { v: string }).v;
}
