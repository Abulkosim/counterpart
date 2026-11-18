// Where a relay run on this machine keeps its database, and running it as a
// service that starts at login: `cpart relay --boot` and `--no-boot`.
//
// The relay belongs to the machine, not to one identity: every identity on it,
// and every container on it, can use the same one. So its files live beside the
// identity homes, in ~/.counterpart-relay, not inside one of them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { relayNames } from "@counterpart/relay";
import { type Boot, MAIN, bootKind, installService, listServices, removeService, serviceHint } from "./service.ts";

export const DEFAULT_RELAY_HOME = join(homedir(), ".counterpart-relay");
export const DEFAULT_PORT = 7447;

export const relayHome = (): string => resolve(process.env.CPART_RELAY_HOME || DEFAULT_RELAY_HOME);

// One file per port: two relays on one machine must not share a database,
// because the relay's id lives in it and clients use the id to tell relays apart.
export function defaultRelayDb(port: number): string {
  mkdirSync(relayHome(), { recursive: true, mode: 0o700 });
  return join(relayHome(), `relay-${port}.db`);
}

const relayLog = (home: string, port: number): string => join(home, `relay-${port}.log`);

// Older versions kept the database in ./relay.db wherever the relay was started.
export function oldDbNotice(cwd: string, db: string): string | undefined {
  if (!existsSync(join(cwd, "relay.db")) || resolve(cwd, "relay.db") === resolve(db)) return undefined;
  return `There is a relay.db in this directory, from an older version. This relay now uses ${db}.\nMessages still queued in the old file are not delivered from the new one. To keep using it: cpart relay --db relay.db`;
}

export interface RelayService {
  name: string;
  kind: Boot;
  home: string;
  port: number;
  host: string;
  db: string;
  urls: string[];
  log: string;
}

const PREFIX = "cpart-relay";

// The default relay home on the default port is plain `cpart-relay`. Others
// get a short hash, so a test with its own relay home cannot replace it.
export function relayServiceName(home: string, port: number): string {
  if (home === DEFAULT_RELAY_HOME && port === DEFAULT_PORT) return PREFIX;
  return `${PREFIX}-${createHash("sha256").update(`${home}\n${port}`).digest("hex").slice(0, 8)}`;
}

// The relay services installed on this machine, for any relay home.
export function relayServices(): RelayService[] {
  const out: RelayService[] = [];
  for (const s of listServices(PREFIX)) {
    const m = /^cpart-relay ([A-Za-z0-9+/=]{1,4000})$/.exec(s.meta ?? "");
    if (!m) continue;
    try {
      const v = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as Partial<RelayService>;
      if (typeof v.port !== "number" || typeof v.host !== "string" || typeof v.db !== "string" || typeof v.home !== "string" || !Array.isArray(v.urls)) continue;
      out.push({ name: s.name, kind: s.kind, home: v.home, port: v.port, host: v.host, db: v.db, urls: v.urls.filter((u) => typeof u === "string"), log: relayLog(v.home, v.port) });
    } catch {
      // Not one of ours, or damaged: leave it out.
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

// The address to check it on from this machine.
const localUrl = (s: { host: string; port: number }): string => {
  const h = ["0.0.0.0", "::", "[::]", "127.0.0.1", "localhost"].includes(s.host) ? "127.0.0.1" : s.host.includes(":") ? `[${s.host}]` : s.host;
  return `http://${h}:${s.port}/healthz`;
};

export async function answering(s: { host: string; port: number }, ms = 1500): Promise<boolean> {
  return fetch(localUrl(s), { signal: AbortSignal.timeout(ms), redirect: "error" }).then((r) => r.ok, () => false);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface BootOpts {
  port: number;
  host: string;
  db: string | undefined;
  urls: string[];
  // Throws with a plain message when the port is held by something else.
  portFree(port: number, host: string): Promise<void>;
}

// `cpart relay --boot`: write the service, start it, and wait for it to answer.
// Run again with other flags, it replaces the service for the same port.
export async function bootRelay(o: BootOpts): Promise<{ service: RelayService; replaced: boolean; names: string[] }> {
  const kind = bootKind();
  if (!kind) {
    throw new Error(
      process.env.CPART_NO_BOOT === "1"
        ? "CPART_NO_BOOT is set, so nothing was installed. Run the relay in a terminal instead: cpart relay"
        : "nothing here can start a program at login (no systemd user session, and this is not a Mac). Run the relay in a terminal instead: cpart relay",
    );
  }
  // Checked before anything is written: a bad --url would make the service restart forever.
  const names = relayNames(o.host, o.port, o.urls).all;
  // A line break would end the line in the unit file and start another.
  for (const v of [o.host, o.db ?? "", ...o.urls]) if (/[\x00-\x1f\x7f]/.test(v)) throw new Error("--host, --db and --url cannot hold line breaks or other control characters. Nothing was installed.");
  const home = relayHome();
  if (/[\x00-\x1f\x7f]/.test(home)) throw new Error("CPART_RELAY_HOME cannot hold line breaks or other control characters. Nothing was installed.");
  const name = relayServiceName(home, o.port);
  const replaced = removeService(name);
  await o.portFree(o.port, o.host);
  const db = resolve(o.db ?? defaultRelayDb(o.port));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const service: RelayService = { name, kind, home, port: o.port, host: o.host, db, urls: o.urls, log: relayLog(home, o.port) };
  const meta = `${PREFIX} ${Buffer.from(JSON.stringify({ home, port: o.port, host: o.host, db, urls: o.urls })).toString("base64")}`;
  installService(kind, {
    name,
    description: `Counterpart relay on port ${o.port}`,
    args: [MAIN, "relay", "--port", String(o.port), "--host", o.host, "--db", db, ...o.urls.flatMap((u) => ["--url", u])],
    env: { CPART_RELAY_HOME: home },
    log: service.log,
    meta,
  });
  const end = Date.now() + 15_000;
  while (!(await answering(service))) {
    if (Date.now() > end) {
      removeService(name);
      throw new Error(`the relay service did not answer within 15 seconds, so it was removed again. See ${service.log}`);
    }
    await sleep(200);
  }
  return { service, replaced, names };
}

// `cpart relay --no-boot [--port]`: stop and remove the services of this relay
// home, or the one on the port given. The database is kept.
export function unbootRelay(port: number | undefined): RelayService[] {
  const home = relayHome();
  const mine = relayServices().filter((s) => (port === undefined ? s.home === home : s.port === port));
  if (port === undefined && mine.length > 1) throw new Error(`relay services run on ports ${mine.map((s) => s.port).join(", ")}. Say which: cpart relay --no-boot --port <port>`);
  for (const s of mine) removeService(s.name);
  return mine;
}

export const relayServiceHint = (s: RelayService): string => serviceHint(s.kind, s.name);
