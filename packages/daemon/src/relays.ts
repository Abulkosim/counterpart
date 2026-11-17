import type { DatabaseSync } from "node:sqlite";
import { type EventBodies, RELAY_LIMITS, isRelayUrl, relayKey } from "@counterpart/protocol";

// Which relays reach whom.
//
// My relays: the home relay (put in invites, tried first by contacts) and any
// others. The daemon keeps a connection to each and accepts mail on all of
// them. A relay can carry a second name, `as`: the address other people use for
// the same relay when this machine reaches it another way, such as a container
// that dials ws://host.docker.internal:7447 for what its host calls
// ws://127.0.0.1:7447.
//
// Their relays: what each contact last told us in a signed contact.relays
// event, or, until they do, the relay we paired on. A contact's list only ever
// decides where mail for that contact goes, and only among relays this machine
// already uses. Nothing a contact or a relay sends makes this machine dial an
// address.

export interface MyRelay {
  url: string; // the address this machine dials
  as: string | null; // the address others know the same relay by
  home: boolean;
  leaving: boolean; // being moved away from: still connected, listed last
}

export interface TheirRelays {
  relays: string[];
  version: number; // 0 until they send a list
  seen: number; // the version of my list they confirmed
}

export interface RelayStatus {
  url: string;
  connected: boolean;
  at: number;
  error: string | null;
}

const CLOCK_SKEW = 10 * 60_000;
const RETRY = 60_000; // an unconfirmed list is sent again after this, doubling
const RETRY_MAX = 3600_000;
const TRIES = 8;
const SPACING = 5_000; // at most one list to a contact in this time

export class RelayBook {
  private db: DatabaseSync;

  constructor(db: DatabaseSync, created: string) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS my_relays (
        url TEXT PRIMARY KEY, as_name TEXT, home INTEGER NOT NULL DEFAULT 0, leaving INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_relays (
        root_key TEXT PRIMARY KEY, relays TEXT, version INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0,
        reply INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL DEFAULT 0, sent_version INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS relay_status (url TEXT PRIMARY KEY, connected INTEGER NOT NULL, at INTEGER NOT NULL, error TEXT);
    `);
    // Identities made before there could be several relays had exactly one:
    // the one in keys.json. Two processes may get here at once.
    db.prepare("INSERT OR IGNORE INTO my_relays (url, as_name, home, leaving, ord) SELECT ?, NULL, 1, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM my_relays)").run(created);
  }

  // ---- mine

  mine(): MyRelay[] {
    return (this.db.prepare("SELECT url, as_name, home, leaving FROM my_relays ORDER BY home DESC, leaving, ord").all() as { url: string; as_name: string | null; home: number; leaving: number }[]).map(
      (r) => ({ url: r.url, as: r.as_name, home: !!r.home, leaving: !!r.leaving }),
    );
  }

  home(): string {
    return this.mine().find((r) => r.home)?.url ?? this.mine()[0]!.url;
  }

  // The names I announce, most preferred first: each relay's own address and
  // the name others know it by.
  names(): string[] {
    const out: string[] = [];
    const keys = new Set<string>();
    for (const r of this.mine()) {
      for (const n of [r.as, r.url]) {
        if (!n || keys.has(relayKey(n))) continue;
        keys.add(relayKey(n));
        out.push(n);
      }
    }
    return out.slice(0, RELAY_LIMITS.names);
  }

  version(): number {
    return (this.db.prepare("SELECT v FROM relay_meta WHERE k = 'version'").get() as { v: number } | undefined)?.v ?? 0;
  }

  // One of my relays, by the address I dial or the one others know it by.
  // `exact`: spelled exactly so, as an invite must be.
  find(name: string, opts: { exact?: boolean } = {}): MyRelay | undefined {
    if (!isRelayUrl(name)) return undefined;
    const k = (u: string): string => (opts.exact ? u : relayKey(u));
    return this.mine().find((r) => k(r.url) === k(name) || (r.as !== null && k(r.as) === k(name)));
  }

  // Each change gets a version above the last and near the clock, so a list
  // made after the database was lost still counts as newer than the old one.
  private bump(now: number): number {
    const v = Math.max(this.version() + 1, now);
    this.db.prepare("INSERT INTO relay_meta (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(v);
    return v;
  }

  // The CLI changes the list while the daemon reads it. Each change is whole.
  private atomic<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // `announce: false` records a second name without telling contacts, for an
  // identity being made: nobody has its list yet.
  add(url: string, as: string | null, now: number, opts: { announce?: boolean } = {}): boolean {
    return this.atomic(() => this.addIn(url, as, now, opts));
  }

  private addIn(url: string, as: string | null, now: number, opts: { announce?: boolean }): boolean {
    if (!isRelayUrl(url)) throw new Error("a relay address is ws:// or wss://, a host, and an optional port and path");
    if (as !== null && !isRelayUrl(as)) throw new Error("--as must be a relay address too");
    if (as !== null && relayKey(as) === relayKey(url)) as = null;
    const have = this.find(url);
    const clash = as === null ? undefined : this.find(as);
    if (clash && clash.url !== have?.url) throw new Error(`${as} is already one of your relays (${clash.url})`);
    if (have) {
      const want = as ?? have.as;
      if (want === have.as && !have.leaving) return false;
      this.db.prepare("UPDATE my_relays SET as_name = ?, leaving = 0 WHERE url = ?").run(want, have.url);
    } else {
      if (this.mine().length >= 8) throw new Error("8 relays is the most one identity can use");
      const ord = (this.db.prepare("SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM my_relays").get() as { n: number }).n;
      this.db.prepare("INSERT INTO my_relays (url, as_name, home, leaving, ord) VALUES (?, ?, 0, 0, ?)").run(url, as, ord);
    }
    if (opts.announce !== false) this.bump(now);
    return true;
  }

  remove(url: string, now: number): MyRelay {
    return this.atomic(() => this.removeIn(url, now));
  }

  private removeIn(url: string, now: number): MyRelay {
    const r = this.find(url);
    if (!r) throw new Error(`${url} is not one of your relays`);
    if (r.home) throw new Error(`${r.url} is your home relay. Move to another first: cpart relay move <url>`);
    this.db.prepare("DELETE FROM my_relays WHERE url = ?").run(r.url);
    this.db.prepare("DELETE FROM relay_status WHERE url = ?").run(r.url);
    this.bump(now);
    return r;
  }

  // Make one relay home. The old home stays connected, listed last, until
  // contacts have confirmed the new list (see `unconfirmed`).
  moveHome(url: string, as: string | null, now: number): { from: string; version: number } {
    return this.atomic(() => this.moveIn(url, as, now));
  }

  private moveIn(url: string, as: string | null, now: number): { from: string; version: number } {
    const from = this.home();
    this.addIn(url, as, now, {});
    const to = this.find(url)!;
    if (to.home) return { from, version: this.version() };
    this.db.prepare("UPDATE my_relays SET home = 0, leaving = 1 WHERE home = 1").run();
    this.db.prepare("UPDATE my_relays SET home = 1, leaving = 0 WHERE url = ?").run(to.url);
    return { from, version: this.bump(now) };
  }

  leaving(): MyRelay[] {
    return this.mine().filter((r) => r.leaving);
  }

  // ---- theirs

  their(root: string, paired: string): TheirRelays {
    const r = this.db.prepare("SELECT relays, version, seen FROM contact_relays WHERE root_key = ?").get(root) as { relays: string | null; version: number; seen: number } | undefined;
    return { relays: r?.relays ? (JSON.parse(r.relays) as string[]) : [paired], version: r?.version ?? 0, seen: r?.seen ?? 0 };
  }

  // A contact's signed list. Returns why it is refused, or null once applied.
  // It changes only this contact's entry.
  apply(root: string, body: EventBodies["contact.relays"], now: number): string | null {
    const mine = this.version();
    if (body.version > now + CLOCK_SKEW) return "relay list dated in the future";
    if (body.seen > mine) return "relay list confirms a version of mine that does not exist";
    const row = this.db.prepare("SELECT relays, version, seen FROM contact_relays WHERE root_key = ?").get(root) as { relays: string | null; version: number; seen: number } | undefined;
    const had = row?.relays ? (JSON.parse(row.relays) as string[]) : null;
    if (had && body.version < row!.version) return "relay list is older than the one already held";
    if (had && body.version === row!.version && JSON.stringify(had) !== JSON.stringify(body.relays)) return "relay list changed without a new version";
    const newer = !had || body.version > row!.version;
    // Confirm a list that is new to us, and resend ours to a contact who lacks it.
    const reply = (newer && body.version > 0) || (mine > 0 && body.seen < mine);
    this.db
      .prepare(
        `INSERT INTO contact_relays (root_key, relays, version, seen, reply) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (root_key) DO UPDATE SET relays = excluded.relays, version = excluded.version, seen = MAX(seen, excluded.seen), reply = MAX(reply, excluded.reply)`,
      )
      .run(root, JSON.stringify(body.relays), body.version, body.seen, reply ? 1 : 0);
    return null;
  }

  // Contacts (of those given) that should be sent my list now: to confirm
  // theirs, or because they have not confirmed mine. Unconfirmed lists are sent
  // again with a growing wait, a few times.
  owed(active: string[], now: number): string[] {
    const mine = this.version();
    const get = this.db.prepare("SELECT reply, seen, sent_at, sent_version, tries FROM contact_relays WHERE root_key = ?");
    return active.filter((root) => {
      const r = (get.get(root) as { reply: number; seen: number; sent_at: number; sent_version: number; tries: number } | undefined) ?? { reply: 0, seen: 0, sent_at: 0, sent_version: 0, tries: 0 };
      if (now - r.sent_at < SPACING) return false;
      if (r.reply) return true;
      if (mine === 0 || r.seen >= mine) return false;
      if (r.sent_version !== mine) return true;
      return r.tries < TRIES && now >= r.sent_at + Math.min(RETRY * 2 ** (r.tries - 1), RETRY_MAX);
    });
  }

  announcement(root: string, paired: string): EventBodies["contact.relays"] {
    return { relays: this.names(), version: this.version(), seen: this.their(root, paired).version };
  }

  sent(root: string, version: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO contact_relays (root_key, reply, sent_at, sent_version, tries) VALUES (?, 0, ?, ?, 1)
         ON CONFLICT (root_key) DO UPDATE SET reply = 0, sent_at = excluded.sent_at, tries = CASE WHEN sent_version = excluded.sent_version THEN tries + 1 ELSE 1 END, sent_version = excluded.sent_version`,
      )
      .run(root, now, version);
  }

  // Of these contacts (root key and the relay we paired on), the ones that have
  // not confirmed my current list, or that do not use any of the relays I am
  // keeping. Until both hold, dropping a relay could cut them off.
  unconfirmed(active: { rootKey: string; relay: string }[]): string[] {
    const mine = this.version();
    const keep = this.mine().filter((r) => !r.leaving).map((r) => r.url);
    return active
      .filter((c) => {
        const t = this.their(c.rootKey, c.relay);
        return t.seen < mine || !this.route(t.relays).preferred.some((u) => keep.includes(u));
      })
      .map((c) => c.rootKey);
  }

  // My contacts' relays that I do not use, so mail from me cannot reach them
  // there. A contact's list never makes this machine dial anything; a person
  // decides with `cpart relay add`.
  missing(contacts: { rootKey: string; relay: string }[]): { rootKey: string; relays: string[] }[] {
    return contacts
      .map((c) => ({ rootKey: c.rootKey, relays: this.their(c.rootKey, c.relay).relays }))
      .filter((t) => this.route(t.relays).preferred.length === 0);
  }

  forget(root: string): void {
    this.db.prepare("DELETE FROM contact_relays WHERE root_key = ?").run(root);
  }

  // ---- routing

  // Which of my relays to send a contact's mail through. `preferred`: those the
  // contact listed, in their order. `fallback`: my other relays, home first,
  // for when none of those can be reached (see link.ts for when that is). With
  // nothing in common, everything goes to the fallback, which starts with my
  // home relay: where all mail went before there could be several.
  route(theirs: string[]): { preferred: string[]; fallback: string[] } {
    const mine = this.mine();
    const preferred: string[] = [];
    for (const name of theirs) {
      if (!isRelayUrl(name)) continue;
      const k = relayKey(name);
      for (const r of mine) if ((relayKey(r.url) === k || (r.as !== null && relayKey(r.as) === k)) && !preferred.includes(r.url)) preferred.push(r.url);
    }
    return { preferred, fallback: mine.map((r) => r.url).filter((u) => !preferred.includes(u)) };
  }

  // ---- what the daemon sees, for `cpart relay list`

  setStatus(url: string, connected: boolean, now: number, error: string | null = null): void {
    this.db.prepare("INSERT INTO relay_status (url, connected, at, error) VALUES (?, ?, ?, ?) ON CONFLICT (url) DO UPDATE SET connected = excluded.connected, at = excluded.at, error = excluded.error").run(url, connected ? 1 : 0, now, error);
  }

  status(): RelayStatus[] {
    return (this.db.prepare("SELECT url, connected, at, error FROM relay_status").all() as { url: string; connected: number; at: number; error: string | null }[]).map((r) => ({ url: r.url, connected: !!r.connected, at: r.at, error: r.error }));
  }
}
