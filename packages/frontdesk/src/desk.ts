import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Counterpart } from "@counterpart/daemon";
import { readBundle } from "./bundle.ts";
import type { Model } from "./model.ts";
import { ASK, systemPrompt, userPrompt } from "./prompt.ts";

export interface DeskConfig {
  contact: string; // local contact name
  enabled: boolean;
  owner: string; // how the owner is named to the contact
  slotsPerThread: number;
  slotsPerDay: number;
}

export interface Run {
  at: number;
  contact: string;
  threadId: string;
  outcome: "answered" | "asked_human" | "no_material" | "out_of_budget" | "failed";
  bundleHash: string | null;
  files: string[];
  replyEventId: string | null;
  ms: number;
  detail: string | null;
}

export interface Ask {
  id: number;
  at: number;
  contact: string;
  threadId: string;
  question: string;
}

const REPLY_CHARS = 6000;
const ASK_CHARS = 300;
const DAY = 24 * 3600 * 1000;

const TEXT = {
  noMaterial: (owner: string) => `This is ${owner}'s front desk. Nothing has been shared with you here yet, so I can't answer. ${owner} will see your message.`,
  outOfBudget: (owner: string) => `This is ${owner}'s front desk. I've used the replies ${owner} allowed for this thread. ${owner} will see the rest of your messages.`,
  asked: (owner: string) => `I can't answer that from what ${owner} has shared. I've passed the question to ${owner}.`,
};

// Answers a contact's questions while the owner is away, from the approved
// bundle only. It replies in threads the contact opened, never in ones the
// owner opened, so two front desks cannot talk to each other in a loop. Every
// reply first takes a slot from a budget only the owner can refill.
export class FrontDesk {
  private node: Counterpart;
  private model: Model;
  private db: DatabaseSync;
  private now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();
  onError: (e: Error) => void = () => {};

  constructor(node: Counterpart, model: Model, opts: { now?: () => number } = {}) {
    this.node = node;
    this.model = model;
    this.now = opts.now ?? Date.now;
    this.db = new DatabaseSync(join(node.home, "frontdesk.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS desks (
        contact_root TEXT PRIMARY KEY, enabled INTEGER NOT NULL, owner TEXT NOT NULL,
        slots_per_thread INTEGER NOT NULL, slots_per_day INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_use (
        thread_id TEXT PRIMARY KEY, used INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS day_use (
        contact_root TEXT NOT NULL, day INTEGER NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (contact_root, day)
      );
      CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, contact_root TEXT NOT NULL, thread_id TEXT NOT NULL,
        outcome TEXT NOT NULL, bundle_hash TEXT, files TEXT NOT NULL, reply_event_id TEXT, ms INTEGER NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS asks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, contact_root TEXT NOT NULL, thread_id TEXT NOT NULL, question TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- configuration, set only by the owner ----

  configure(contactName: string, patch: Partial<Omit<DeskConfig, "contact">>): DeskConfig {
    const c = this.node.contact(contactName);
    const cur = this.config(c.name);
    const next = { ...cur, ...patch };
    if (!Number.isInteger(next.slotsPerThread) || next.slotsPerThread < 1 || next.slotsPerThread > 100) throw new Error("replies per thread must be 1-100");
    if (!Number.isInteger(next.slotsPerDay) || next.slotsPerDay < 1 || next.slotsPerDay > 1000) throw new Error("replies per day must be 1-1000");
    if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(next.owner)) throw new Error("owner name: 1-40 letters, digits, spaces, dot, dash, underscore");
    this.db
      .prepare("INSERT INTO desks (contact_root, enabled, owner, slots_per_thread, slots_per_day) VALUES (?, ?, ?, ?, ?) ON CONFLICT (contact_root) DO UPDATE SET enabled = excluded.enabled, owner = excluded.owner, slots_per_thread = excluded.slots_per_thread, slots_per_day = excluded.slots_per_day")
      .run(c.rootKey, next.enabled ? 1 : 0, next.owner, next.slotsPerThread, next.slotsPerDay);
    return next;
  }

  config(contactName: string): DeskConfig {
    const c = this.node.contact(contactName);
    const r = this.db.prepare("SELECT * FROM desks WHERE contact_root = ?").get(c.rootKey) as DeskRow | undefined;
    return { contact: c.name, enabled: !!r?.enabled, owner: r?.owner ?? "the owner", slotsPerThread: r?.slots_per_thread ?? 6, slotsPerDay: r?.slots_per_day ?? 30 };
  }

  desks(): DeskConfig[] {
    return this.node.contacts().map((c) => this.config(c.name));
  }

  // Give a thread its replies back. Only ever called by the owner.
  refill(threadId: string): void {
    this.db.prepare("DELETE FROM thread_use WHERE thread_id = ?").run(threadId);
  }

  runs(limit = 50): Run[] {
    const names = new Map(this.node.contacts().map((c) => [c.rootKey, c.name]));
    return (this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as unknown as RunRow[]).map((r) => ({
      at: r.at, contact: names.get(r.contact_root) ?? "?", threadId: r.thread_id, outcome: r.outcome, bundleHash: r.bundle_hash,
      files: JSON.parse(r.files) as string[], replyEventId: r.reply_event_id, ms: r.ms, detail: r.detail,
    }));
  }

  asks(limit = 50): Ask[] {
    const names = new Map(this.node.contacts().map((c) => [c.rootKey, c.name]));
    return (this.db.prepare("SELECT * FROM asks ORDER BY id DESC LIMIT ?").all(limit) as unknown as { id: number; at: number; contact_root: string; thread_id: string; question: string }[]).map((r) => ({
      id: r.id, at: r.at, contact: names.get(r.contact_root) ?? "?", threadId: r.thread_id, question: r.question,
    }));
  }

  // ---- the loop ----

  start(intervalMs = 500): this {
    this.timer = setInterval(() => void this.tick().catch((e: Error) => this.onError(e)), intervalMs);
    return this;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running.catch(() => {});
  }

  // Look at everything applied since last time and answer where due. Calls are
  // serialised; a call made while another runs waits for it and then runs.
  tick(): Promise<void> {
    const next = this.running.catch(() => {}).then(() => this.work());
    this.running = next;
    return next;
  }

  private async work(): Promise<void> {
    let cursor = (this.db.prepare("SELECT v FROM state WHERE k = 'cursor'").get() as { v: number } | undefined)?.v ?? 0;
    for (;;) {
      const batch = this.node.since(cursor, 200);
      if (batch.length === 0) return;
      const threads = new Set<string>();
      for (const e of batch) {
        if (!e.mine && e.type === "talk.posted") threads.add(e.threadId);
        cursor = e.ord!;
      }
      // If we crash mid-batch the cursor has not moved and these threads are
      // looked at again; `answer` skips any whose last word is already ours.
      for (const t of threads) await this.answer(t);
      this.db.prepare("INSERT INTO state (k, v) VALUES ('cursor', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(cursor);
    }
  }

  private async answer(threadId: string): Promise<void> {
    const thread = this.node.threads().find((t) => t.id === threadId);
    if (!thread || thread.openedByMe) return;
    const cfg = this.config(thread.contact);
    if (!cfg.enabled) return;
    const contact = this.node.contact(thread.contact);
    const lastIsMine = (): boolean => this.node.log(threadId).filter((e) => e.status === "applied").at(-1)?.mine === true;
    if (lastIsMine()) return;

    const started = this.now();
    const record = (outcome: Run["outcome"], extra: { bundleHash?: string; files?: string[]; replyEventId?: string; detail?: string } = {}): void => {
      this.db
        .prepare("INSERT INTO runs (at, contact_root, thread_id, outcome, bundle_hash, files, reply_event_id, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(started, contact.rootKey, threadId, outcome, extra.bundleHash ?? null, JSON.stringify(extra.files ?? []), extra.replyEventId ?? null, this.now() - started, extra.detail ?? null);
    };

    const slot = this.takeSlot(contact.rootKey, threadId, cfg);
    if (slot === "none") return;
    if (slot === "last-notice") {
      const e = await this.node.say(threadId, TEXT.outOfBudget(cfg.owner), "frontdesk");
      return record("out_of_budget", { replyEventId: e.id });
    }

    const bundle = readBundle(this.node.home, contact.name);
    if (bundle.files.length === 0) {
      const e = await this.node.say(threadId, TEXT.noMaterial(cfg.owner), "frontdesk");
      return record("no_material", { replyEventId: e.id });
    }

    let raw: string;
    try {
      raw = await this.model({ system: systemPrompt(cfg.owner, contact.name, bundle), prompt: userPrompt(contact.name, thread.goal, this.node.log(threadId)) });
    } catch (e) {
      // The slot stays spent: a peer must not be able to get free retries by making the model fail.
      return record("failed", { bundleHash: bundle.hash, detail: (e as Error).message.slice(0, 300) });
    }

    const lines = raw.split("\n");
    const asks = lines.filter((l) => l.trimStart().startsWith(ASK)).map((l) => l.trimStart().slice(ASK.length).trim().slice(0, ASK_CHARS)).filter(Boolean);
    let reply = lines.filter((l) => !l.trimStart().startsWith(ASK)).join("\n").trim();
    if (asks.length > 0) {
      this.db.prepare("INSERT INTO asks (at, contact_root, thread_id, question) VALUES (?, ?, ?, ?)").run(this.now(), contact.rootKey, threadId, asks[0]!);
      reply = reply ? `${reply}\n\n${TEXT.asked(cfg.owner)}` : TEXT.asked(cfg.owner);
    }
    if (!reply) return record("failed", { bundleHash: bundle.hash, detail: "empty reply" });
    if (reply.length > REPLY_CHARS) reply = `${reply.slice(0, REPLY_CHARS)}\n[cut short]`;
    // The owner may have answered while the model was working.
    if (lastIsMine()) return record("failed", { bundleHash: bundle.hash, detail: "owner replied first" });

    const e = await this.node.say(threadId, reply, "frontdesk");
    record(asks.length > 0 ? "asked_human" : "answered", { bundleHash: bundle.hash, files: bundle.files.map((f) => f.name).filter((n) => reply.includes(n)), replyEventId: e.id });
  }

  // "slot": go ahead. "last-notice": budget just ran out, say so once. "none": stay silent.
  private takeSlot(contactRoot: string, threadId: string, cfg: DeskConfig): "slot" | "last-notice" | "none" {
    const day = Math.floor(this.now() / DAY);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const t = (this.db.prepare("SELECT used, notified FROM thread_use WHERE thread_id = ?").get(threadId) as { used: number; notified: number } | undefined) ?? { used: 0, notified: 0 };
      const d = (this.db.prepare("SELECT used FROM day_use WHERE contact_root = ? AND day = ?").get(contactRoot, day) as { used: number } | undefined)?.used ?? 0;
      let out: "slot" | "last-notice" | "none";
      if (t.used < cfg.slotsPerThread && d < cfg.slotsPerDay) {
        this.db.prepare("INSERT INTO thread_use (thread_id, used) VALUES (?, 1) ON CONFLICT (thread_id) DO UPDATE SET used = used + 1").run(threadId);
        this.db.prepare("INSERT INTO day_use (contact_root, day, used) VALUES (?, ?, 1) ON CONFLICT (contact_root, day) DO UPDATE SET used = used + 1").run(contactRoot, day);
        out = "slot";
      } else if (!t.notified) {
        this.db.prepare("INSERT INTO thread_use (thread_id, used, notified) VALUES (?, 0, 1) ON CONFLICT (thread_id) DO UPDATE SET notified = 1").run(threadId);
        out = "last-notice";
      } else out = "none";
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

interface DeskRow {
  enabled: number;
  owner: string;
  slots_per_thread: number;
  slots_per_day: number;
}
interface RunRow {
  at: number;
  contact_root: string;
  thread_id: string;
  outcome: Run["outcome"];
  bundle_hash: string | null;
  files: string;
  reply_event_id: string | null;
  ms: number;
  detail: string | null;
}
