import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type DeviceCredential, type DeviceSecrets, type EventBodies, type EventType, type KeyPair, type ThreadEvent, type Wire,
  LIMITS, canonicalize, decodeInvite, deviceId, encodeInvite, generateSigningKey, humanId, issueDevice, laneOf, open,
  randomId, renewDevice, safetyCode, seal,
} from "@counterpart/protocol";

const DAY = 24 * 3600 * 1000;
const RENEW_BEFORE = 30 * DAY;
const MAX_PENDING_PER_CONTACT = 200;
const CLOCK_SKEW = 10 * 60_000;
const MAX_REJECTS = 1000;

interface Keys {
  v: 1;
  relay: string;
  root: KeyPair;
  device: DeviceSecrets;
}

export interface Contact {
  rootKey: string;
  name: string;
  credential: DeviceCredential;
  relay: string;
  state: "pending" | "active";
  safetyCode: string;
}

export interface StoredEvent extends ThreadEvent {
  ord: number | null; // local order in which the event took effect
  mine: boolean;
  status: "applied" | "pending";
  receivedAt: number;
}

export interface ThreadSummary {
  id: string;
  goal: string;
  contact: string;
  openedByMe: boolean;
  events: number;
  lastAt: number;
}

export type Verdict =
  | { result: "applied"; event: ThreadEvent; promoted: ThreadEvent[] }
  | { result: "pending"; event: ThreadEvent }
  | { result: "duplicate" }
  | { result: "rejected"; reason: string };

interface Outgoing {
  event: ThreadEvent;
  wire: Wire;
  expiresAt: number;
}

class Reject extends Error {}

const hashOf = (e: ThreadEvent): string => createHash("sha256").update(canonicalize(e)).digest("base64url");

// The local node: keys, contacts, the event log and the outbox. Everything a
// peer sends passes through `receive`, which is plain code with no model in it.
export class Counterpart {
  readonly home: string;
  private keys: Keys;
  private db: DatabaseSync;
  private now: () => number;

  private constructor(home: string, keys: Keys, now: () => number) {
    this.home = home;
    this.keys = keys;
    this.now = now;
    this.db = new DatabaseSync(join(home, "state.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS contacts (
        root_key TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, credential TEXT NOT NULL,
        relay TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        token TEXT PRIMARY KEY, name TEXT NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, goal TEXT NOT NULL, contact_root TEXT NOT NULL,
        opened_by_me INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, author TEXT NOT NULL, author_root TEXT NOT NULL,
        author_seq INTEGER NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, mine INTEGER NOT NULL,
        status TEXT NOT NULL, received_at INTEGER NOT NULL, ord INTEGER,
        UNIQUE (thread_id, author, author_seq)
      );
      CREATE INDEX IF NOT EXISTS events_thread ON events (thread_id, ord);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, wire TEXT NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS rejects (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, reason TEXT NOT NULL, wire_id TEXT
      );
    `);
  }

  static async init(home: string, opts: { relay: string; now?: () => number }): Promise<Counterpart> {
    const file = join(home, "keys.json");
    if (existsSync(file)) throw new Error(`already initialised at ${home}`);
    const url = new URL(opts.relay);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("relay must be a ws:// or wss:// URL");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const now = opts.now ?? Date.now;
    const root = generateSigningKey();
    const keys: Keys = { v: 1, relay: opts.relay, root, device: await issueDevice(root, now()) };
    saveKeys(home, keys);
    return new Counterpart(home, keys, now);
  }

  static open(home: string, opts: { now?: () => number } = {}): Counterpart {
    const file = join(home, "keys.json");
    if (!existsSync(file)) throw new Error(`no Counterpart identity at ${home}. Run: cpart init --relay <url>`);
    const keys = JSON.parse(readFileSync(file, "utf8")) as Keys;
    return new Counterpart(home, keys, opts.now ?? Date.now);
  }

  // Renew this device's credential when it is within 30 days of expiry, and
  // tell every contact, so neither side is left holding an expired credential
  // for the other. Safe to call often and from several processes.
  async renewIfDue(): Promise<boolean> {
    const onDisk = JSON.parse(readFileSync(join(this.home, "keys.json"), "utf8")) as Keys;
    if (onDisk.device.credential.issuedAt > this.keys.device.credential.issuedAt) this.keys = onDisk;
    if (this.keys.device.credential.expiresAt - this.now() >= RENEW_BEFORE) return false;
    this.keys = { ...this.keys, device: renewDevice(this.keys.root, this.keys.device, this.now()) };
    saveKeys(this.home, this.keys);
    for (const c of this.contacts()) {
      if (c.state !== "active") continue;
      const out = await this.build(c.credential, randomId(), "contact.hello", {}, 0, []);
      this.tx(() => this.commitOut(out));
    }
    return true;
  }

  close(): void {
    this.db.close();
  }

  get relay(): string {
    return this.keys.relay;
  }
  get device(): DeviceSecrets {
    return this.keys.device;
  }
  get me(): { human: string; device: string; rootKey: string; relay: string } {
    return { human: humanId(this.keys.root.publicKey), device: deviceId(this.keys.device.credential), rootKey: this.keys.root.publicKey, relay: this.keys.relay };
  }

  // ---- contacts ----

  createInvite(name: string, ttlMs = DAY): string {
    checkName(name);
    if (this.db.prepare("SELECT 1 FROM contacts WHERE name = ?").get(name)) throw new Error(`contact "${name}" already exists`);
    const token = randomId();
    const expiresAt = this.now() + ttlMs;
    this.db.prepare("INSERT INTO invites (token, name, expires_at) VALUES (?, ?, ?)").run(token, name, expiresAt);
    return encodeInvite({ v: 1, relay: this.keys.relay, credential: this.keys.device.credential, token, expiresAt });
  }

  async acceptInvite(invite: string, name: string): Promise<Contact> {
    checkName(name);
    const inv = decodeInvite(invite, this.now());
    if (inv.credential.rootKey === this.keys.root.publicKey) throw new Error("that is your own invite");
    if (inv.relay !== this.keys.relay) throw new Error(`invite is for relay ${inv.relay}, this identity uses ${this.keys.relay}`);
    if (this.db.prepare("SELECT 1 FROM contacts WHERE name = ? OR root_key = ?").get(name, inv.credential.rootKey)) throw new Error("you already have this contact, or that name is taken");
    const out = await this.build(inv.credential, randomId(), "contact.request", { token: inv.token }, 0, []);
    this.tx(() => {
      this.db
        .prepare("INSERT INTO contacts (root_key, name, credential, relay, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
        .run(inv.credential.rootKey, name, JSON.stringify(inv.credential), inv.relay, this.now());
      this.commitOut(out);
    });
    return this.contact(name);
  }

  contacts(): Contact[] {
    return (this.db.prepare("SELECT * FROM contacts ORDER BY name").all() as unknown as ContactRow[]).map((r) => this.toContact(r));
  }

  contact(nameOrRoot: string): Contact {
    const r = this.db.prepare("SELECT * FROM contacts WHERE name = ? OR root_key = ?").get(nameOrRoot, nameOrRoot) as ContactRow | undefined;
    if (!r) throw new Error(`no contact "${nameOrRoot}"`);
    return this.toContact(r);
  }

  private toContact(r: ContactRow): Contact {
    return {
      rootKey: r.root_key, name: r.name, credential: JSON.parse(r.credential), relay: r.relay, state: r.state,
      safetyCode: safetyCode(this.keys.root.publicKey, r.root_key),
    };
  }

  // ---- threads ----

  async openThread(contactName: string, goal: string): Promise<string> {
    const c = this.activeContact(contactName);
    const threadId = randomId();
    const out = await this.build(c.credential, threadId, "thread.opened", { goal, participants: [this.keys.root.publicKey, c.rootKey] }, 0, []);
    this.tx(() => {
      this.db.prepare("INSERT INTO threads (id, goal, contact_root, opened_by_me, created_at) VALUES (?, ?, ?, 1, ?)").run(threadId, goal, c.rootKey, this.now());
      this.commitOut(out);
    });
    return threadId;
  }

  async say(threadId: string, text: string): Promise<ThreadEvent> {
    const t = this.db.prepare("SELECT contact_root FROM threads WHERE id = ?").get(threadId) as { contact_root: string } | undefined;
    if (!t) throw new Error(`no thread ${threadId}`);
    const c = this.activeContact(t.contact_root);
    const mine = deviceId(this.keys.device.credential);
    // Sequence numbers are allocated here and committed below; a clash with a
    // concurrent writer fails the unique index and the caller retries.
    for (let attempt = 0; ; attempt++) {
      const seq = (this.db.prepare("SELECT COALESCE(MAX(author_seq), -1) + 1 AS n FROM events WHERE thread_id = ? AND author = ?").get(threadId, mine) as { n: number }).n;
      const out = await this.build(c.credential, threadId, "talk.posted", { text }, seq, this.heads(threadId));
      try {
        this.tx(() => this.commitOut(out));
        return out.event;
      } catch (e) {
        if (attempt >= 5 || !/UNIQUE/.test((e as Error).message)) throw e;
      }
    }
  }

  threads(): ThreadSummary[] {
    return (
      this.db
        .prepare(
          `SELECT t.id, t.goal, c.name AS contact, t.opened_by_me, COUNT(e.id) AS events, COALESCE(MAX(e.received_at), t.created_at) AS last_at
           FROM threads t JOIN contacts c ON c.root_key = t.contact_root
           LEFT JOIN events e ON e.thread_id = t.id AND e.status = 'applied'
           GROUP BY t.id ORDER BY last_at DESC`,
        )
        .all() as unknown as { id: string; goal: string; contact: string; opened_by_me: number; events: number; last_at: number }[]
    ).map((r) => ({ id: r.id, goal: r.goal, contact: r.contact, openedByMe: !!r.opened_by_me, events: r.events, lastAt: r.last_at }));
  }

  log(threadId: string): StoredEvent[] {
    const rows = this.db.prepare("SELECT json, mine, status, received_at, ord FROM events WHERE thread_id = ? ORDER BY ord IS NULL, ord, rowid").all(threadId) as unknown as EventRow[];
    return rows.map(toStored);
  }

  // Applied events after a cursor, in the order they took effect. A consumer
  // that stores the last `ord` it handled never misses or repeats an event.
  since(ord: number, limit = 100): StoredEvent[] {
    const rows = this.db.prepare("SELECT json, mine, status, received_at, ord FROM events WHERE ord > ? ORDER BY ord LIMIT ?").all(ord, limit) as unknown as EventRow[];
    return rows.map(toStored);
  }

  rejects(limit = 50): { at: number; reason: string; wireId: string | null }[] {
    return (this.db.prepare("SELECT at, reason, wire_id FROM rejects ORDER BY seq DESC LIMIT ?").all(limit) as unknown as { at: number; reason: string; wire_id: string | null }[]).map(
      (r) => ({ at: r.at, reason: r.reason, wireId: r.wire_id }),
    );
  }

  private heads(threadId: string): string[] {
    const events = (this.db.prepare("SELECT json FROM events WHERE thread_id = ? AND status = 'applied' ORDER BY ord DESC").all(threadId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as ThreadEvent,
    );
    const referenced = new Set(events.flatMap((e) => e.parents));
    return events.filter((e) => !referenced.has(e.id)).slice(0, LIMITS.parents).map((e) => e.id);
  }

  private activeContact(nameOrRoot: string): Contact {
    const c = this.contact(nameOrRoot);
    if (c.state !== "active") throw new Error(`contact "${c.name}" has not accepted yet`);
    if (c.credential.expiresAt <= this.now()) throw new Error(`contact "${c.name}" has an expired device credential. It renews when they next send a message.`);
    return c;
  }

  // ---- outbound ----

  // Sealing is async and SQLite transactions are not, so an outgoing event is
  // built first and committed (log entry plus outbox row) in one transaction.
  private async build<T extends EventType>(to: DeviceCredential, threadId: string, type: T, body: EventBodies[T], authorSeq: number, parents: string[]): Promise<Outgoing> {
    const now = this.now();
    const event = { id: randomId(), threadId, author: deviceId(this.keys.device.credential), authorSeq, parents, lane: laneOf(type), type, body, createdAt: now } as ThreadEvent;
    const expiresAt = now + LIMITS.maxTtlMs - 60_000;
    return { event, wire: await seal(event, this.keys.device, to, expiresAt), expiresAt };
  }

  private commitOut(out: Outgoing): void {
    this.insertEvent(out.event, this.keys.root.publicKey, true, "applied");
    this.db.prepare("INSERT INTO outbox (id, wire, expires_at, state) VALUES (?, ?, ?, 'queued')").run(out.event.id, JSON.stringify(out.wire), out.expiresAt);
  }

  queued(): Wire[] {
    this.db.prepare("UPDATE outbox SET state = 'expired' WHERE state = 'queued' AND expires_at <= ?").run(this.now());
    return (this.db.prepare("SELECT wire FROM outbox WHERE state = 'queued' ORDER BY rowid").all() as { wire: string }[]).map((r) => JSON.parse(r.wire) as Wire);
  }

  markOutbox(id: string, state: "stored" | "failed", detail?: string): void {
    this.db.prepare("UPDATE outbox SET state = ?, detail = ? WHERE id = ? AND state = 'queued'").run(state, detail ?? null, id);
  }

  outboxState(id: string): string | undefined {
    return (this.db.prepare("SELECT state FROM outbox WHERE id = ?").get(id) as { state: string } | undefined)?.state;
  }

  // ---- inbound ----

  // Decide what to do with one message from the relay. Never throws for bad
  // input: anything unacceptable is recorded and dropped.
  async receive(wire: unknown): Promise<Verdict> {
    let wireId: string | null = null;
    try {
      const w = wire as { header?: { id?: unknown } } | null;
      if (typeof w?.header?.id === "string") wireId = w.header.id.slice(0, 64);
      let opened;
      try {
        opened = await open(wire, this.keys.device, this.now());
      } catch (e) {
        throw new Reject((e as Error).message);
      }
      const { event, credential } = opened;
      if (credential.rootKey === this.keys.root.publicKey) throw new Reject("message from my own identity");
      if (event.createdAt > this.now() + CLOCK_SKEW) throw new Reject("event dated in the future");

      // Built before the transaction so accepting a contact and queueing the
      // reply commit together.
      const acceptance = event.type === "contact.request" ? await this.build(credential, event.threadId, "contact.accepted", {}, 0, [event.id]) : null;

      return this.tx((): Verdict => {
        const hash = hashOf(event);
        const seen = this.db.prepare("SELECT hash FROM events WHERE id = ?").get(event.id) as { hash: string } | undefined;
        if (seen) {
          if (seen.hash !== hash) throw new Reject("event id reused with different content");
          return { result: "duplicate" };
        }
        const clash = this.db.prepare("SELECT id FROM events WHERE thread_id = ? AND author = ? AND author_seq = ?").get(event.threadId, event.author, event.authorSeq);
        if (clash) throw new Reject("two different events claim the same sequence number");

        const contact = this.db.prepare("SELECT * FROM contacts WHERE root_key = ?").get(credential.rootKey) as ContactRow | undefined;

        if (event.type === "contact.request") {
          const token = (event as ThreadEvent<"contact.request">).body.token;
          const inv = this.db.prepare("SELECT * FROM invites WHERE token = ?").get(token) as { name: string; expires_at: number; used_by: string | null } | undefined;
          if (!inv) throw new Reject("contact request with unknown invite token");
          if (inv.used_by) throw new Reject("invite token already used");
          if (inv.expires_at <= this.now()) throw new Reject("invite expired");
          if (contact) throw new Reject("contact request from an existing contact");
          if (this.db.prepare("SELECT 1 FROM contacts WHERE name = ?").get(inv.name)) throw new Reject("invite name is now taken by another contact");
          this.db.prepare("UPDATE invites SET used_by = ? WHERE token = ?").run(credential.rootKey, token);
          this.db
            .prepare("INSERT INTO contacts (root_key, name, credential, relay, state, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
            .run(credential.rootKey, inv.name, JSON.stringify(credential), this.keys.relay, this.now());
          this.insertEvent(event, credential.rootKey, false, "applied");
          this.commitOut(acceptance!);
          return { result: "applied", event, promoted: [] };
        }

        if (!contact) throw new Reject("message from an unknown sender");
        this.refreshCredential(contact, credential);
        const hold = (): Verdict => {
          const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE author_root = ? AND status = 'pending'").get(credential.rootKey) as { n: number }).n;
          if (pending >= MAX_PENDING_PER_CONTACT) throw new Reject("too many out-of-order events held for this contact");
          this.insertEvent(event, credential.rootKey, false, "pending");
          return { result: "pending", event };
        };

        if (event.type === "contact.accepted") {
          if (contact.state !== "pending") throw new Reject("unexpected contact.accepted");
          this.db.prepare("UPDATE contacts SET state = 'active' WHERE root_key = ?").run(contact.root_key);
          this.insertEvent(event, credential.rootKey, false, "applied");
          // Anything they sent that overtook this acceptance was held; apply it now.
          const threads = this.db.prepare("SELECT DISTINCT thread_id FROM events WHERE author_root = ? AND status = 'pending'").all(credential.rootKey) as { thread_id: string }[];
          return { result: "applied", event, promoted: threads.flatMap((t) => this.promote(t.thread_id)) };
        }
        // The peer accepted us and wrote straight away, and the relay delivered
        // that before their acceptance. Hold it rather than lose it.
        if (contact.state !== "active") return hold();
        if (event.type === "contact.hello") {
          this.insertEvent(event, credential.rootKey, false, "applied");
          return { result: "applied", event, promoted: [] };
        }

        if (!this.ready(event, credential.rootKey)) return hold();
        this.apply(event, credential.rootKey);
        this.insertEvent(event, credential.rootKey, false, "applied");
        return { result: "applied", event, promoted: this.promote(event.threadId) };
      });
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      this.reject(e.message, wireId);
      return { result: "rejected", reason: e.message };
    }
  }

  // Can this event be applied now, or must it wait for earlier ones? Throws if
  // it can never be valid.
  private ready(event: ThreadEvent, authorRoot: string): boolean {
    if (event.type === "contact.hello") return true;
    if (event.type === "contact.request" || event.type === "contact.accepted") throw new Reject("contact event inside a thread");
    if (event.type === "thread.opened") {
      const body = (event as ThreadEvent<"thread.opened">).body;
      if (event.authorSeq !== 0 || event.parents.length !== 0) throw new Reject("thread.opened must be the first event");
      const want = [this.keys.root.publicKey, authorRoot].sort();
      if (body.participants.length !== 2 || [...body.participants].sort().join() !== want.join()) throw new Reject("thread participants must be exactly the two of us");
      if (this.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(event.threadId)) throw new Reject("thread already exists");
      return true;
    }
    const thread = this.db.prepare("SELECT contact_root FROM threads WHERE id = ?").get(event.threadId) as { contact_root: string } | undefined;
    if (!thread) return false;
    if (thread.contact_root !== authorRoot) throw new Reject("sender is not a participant of this thread");
    const known = this.db.prepare("SELECT 1 FROM events WHERE id = ? AND thread_id = ? AND status = 'applied'");
    return event.parents.every((p) => known.get(p, event.threadId));
  }

  private apply(event: ThreadEvent, authorRoot: string): void {
    if (event.type === "thread.opened") {
      const body = (event as ThreadEvent<"thread.opened">).body;
      this.db.prepare("INSERT INTO threads (id, goal, contact_root, opened_by_me, created_at) VALUES (?, ?, ?, 0, ?)").run(event.threadId, body.goal, authorRoot, this.now());
    }
  }

  // Apply held events whose dependencies have now arrived. Ones that turn out
  // to be invalid are dropped and recorded.
  private promote(threadId: string): ThreadEvent[] {
    const promoted: ThreadEvent[] = [];
    for (let progress = true; progress; ) {
      progress = false;
      const held = this.db.prepare("SELECT json, author_root FROM events WHERE thread_id = ? AND status = 'pending' ORDER BY author_seq").all(threadId) as { json: string; author_root: string }[];
      for (const row of held) {
        const event = JSON.parse(row.json) as ThreadEvent;
        try {
          if (!this.ready(event, row.author_root)) continue;
          this.apply(event, row.author_root);
          this.db.prepare("UPDATE events SET status = 'applied', received_at = ?, ord = ? WHERE id = ?").run(this.now(), this.nextOrd(), event.id);
          promoted.push(event);
        } catch (e) {
          if (!(e instanceof Reject)) throw e;
          this.db.prepare("DELETE FROM events WHERE id = ?").run(event.id);
          this.reject(e.message, event.id);
        }
        progress = true;
      }
    }
    return promoted;
  }

  // A contact's device credential rotates. Their root key vouches for the new
  // one, so take the newest.
  private refreshCredential(contact: ContactRow, credential: DeviceCredential): void {
    const current = JSON.parse(contact.credential) as DeviceCredential;
    if (credential.issuedAt > current.issuedAt) {
      this.db.prepare("UPDATE contacts SET credential = ? WHERE root_key = ?").run(JSON.stringify(credential), contact.root_key);
    }
  }

  private insertEvent(event: ThreadEvent, authorRoot: string, mine: boolean, status: "applied" | "pending"): void {
    this.db
      .prepare("INSERT INTO events (id, thread_id, author, author_root, author_seq, hash, json, mine, status, received_at, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(event.id, event.threadId, event.author, authorRoot, event.authorSeq, hashOf(event), JSON.stringify(event), mine ? 1 : 0, status, this.now(), status === "applied" ? this.nextOrd() : null);
  }

  // Local order in which events took effect. Always called inside a transaction.
  private nextOrd(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM events").get() as { n: number }).n;
  }

  private reject(reason: string, wireId: string | null): void {
    this.db.prepare("INSERT INTO rejects (at, reason, wire_id) VALUES (?, ?, ?)").run(this.now(), reason, wireId);
    this.db.prepare("DELETE FROM rejects WHERE seq <= (SELECT MAX(seq) FROM rejects) - ?").run(MAX_REJECTS);
  }

  private tx<T>(fn: () => T): T {
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
}

interface ContactRow {
  root_key: string;
  name: string;
  credential: string;
  relay: string;
  state: "pending" | "active";
}
interface EventRow {
  json: string;
  mine: number;
  status: "applied" | "pending";
  received_at: number;
  ord: number | null;
}

const toStored = (r: EventRow): StoredEvent => ({ ...(JSON.parse(r.json) as ThreadEvent), ord: r.ord, mine: !!r.mine, status: r.status, receivedAt: r.received_at });

function checkName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(name)) throw new Error("contact names are 1-32 characters: a-z, 0-9, dot, dash, underscore");
}

function saveKeys(home: string, keys: Keys): void {
  const file = join(home, "keys.json");
  // Unique temporary name, flushed before the rename and the directory flushed
  // after, so a crash or a second process never leaves a partial identity file.
  const tmp = `${file}.${process.pid}.${randomId(6)}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(keys, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  const dir = openSync(home, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
