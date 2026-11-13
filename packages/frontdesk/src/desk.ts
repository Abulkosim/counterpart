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
  // "answered" also covers the owner writing in the thread after the question.
  state: "open" | "answered" | "dismissed";
  closedAt: number | null;
}

const REPLY_CHARS = 6000;
const ASK_CHARS = 300;
const DAY = 24 * 3600 * 1000;
const NOTICES_PER_DAY = 3;
const ROUNDS = 3;

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
  private forbidden: string[];
  onError: (e: Error) => void = () => {};
  // Called after each run is recorded, so the daemon can log it.
  onRun: (run: { outcome: Run["outcome"]; contact: string; threadId: string; detail: string | null }) => void = () => {};

  // `forbidden` are exact strings that must never appear in a reply, such as
  // values the model runtime adds to its own context. A reply containing one is
  // dropped. This catches accidents and plain leaks, not a determined encoder.
  constructor(node: Counterpart, model: Model, opts: { now?: () => number; forbidden?: string[] } = {}) {
    this.forbidden = (opts.forbidden ?? []).filter((f) => f.length >= 4).map((f) => f.toLowerCase());
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
        thread_id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0,
        answered_ord INTEGER NOT NULL DEFAULT 0, posting_ord INTEGER
      );
      CREATE TABLE IF NOT EXISTS day_use (
        contact_root TEXT NOT NULL, day INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, notices INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (contact_root, day)
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
    // Columns added after the table first shipped.
    const cols = (this.db.prepare("PRAGMA table_info(asks)").all() as unknown as { name: string }[]).map((c) => c.name);
    if (!cols.includes("closed_at")) this.db.exec("ALTER TABLE asks ADD COLUMN closed_at INTEGER; ALTER TABLE asks ADD COLUMN closed_how TEXT;");
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
    this.db.prepare("UPDATE thread_use SET used = 0, notified = 0 WHERE thread_id = ?").run(threadId);
  }

  runs(limit = 50): Run[] {
    const names = new Map(this.node.contacts().map((c) => [c.rootKey, c.name]));
    return (this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as unknown as RunRow[]).map((r) => ({
      at: r.at, contact: names.get(r.contact_root) ?? "?", threadId: r.thread_id, outcome: r.outcome, bundleHash: r.bundle_hash,
      files: JSON.parse(r.files) as string[], replyEventId: r.reply_event_id, ms: r.ms, detail: r.detail,
    }));
  }

  // A question is open until the owner answers or dismisses it, or writes in
  // that thread themselves after it was asked.
  asks(limit = 50): Ask[] {
    const names = new Map(this.node.contacts().map((c) => [c.rootKey, c.name]));
    const lastOwnerWord = new Map<string, number>();
    const ownerWroteAfter = (threadId: string, at: number): boolean => {
      if (!lastOwnerWord.has(threadId)) {
        const own = this.node.log(threadId).filter((e) => e.mine && e.type === "talk.posted" && (e.body as { via?: string }).via !== "frontdesk");
        lastOwnerWord.set(threadId, own.at(-1)?.createdAt ?? 0);
      }
      return lastOwnerWord.get(threadId)! > at;
    };
    return (this.db.prepare("SELECT * FROM asks ORDER BY id DESC LIMIT ?").all(limit) as unknown as AskRow[]).map((r) => ({
      id: r.id, at: r.at, contact: names.get(r.contact_root) ?? "?", threadId: r.thread_id, question: r.question,
      state: r.closed_how ?? (ownerWroteAfter(r.thread_id, r.at) ? "answered" : "open"),
      closedAt: r.closed_at,
    }));
  }

  // Only ever called by the owner. With text, the text goes to the contact as
  // the owner's own message first; the question is closed once that is recorded.
  async answerAsk(id: number, text?: string): Promise<Ask> {
    const ask = this.openAsk(id);
    if (text !== undefined) await this.node.say(ask.threadId, text, "human");
    return this.closeAsk(ask, "answered");
  }

  dismissAsk(id: number): Ask {
    return this.closeAsk(this.openAsk(id), "dismissed");
  }

  private openAsk(id: number): Ask {
    const ask = Number.isSafeInteger(id) ? this.asks(1_000_000).find((a) => a.id === id) : undefined;
    if (!ask) throw new Error(`no question ${id}. See: cpart asks --all`);
    if (ask.state !== "open") throw new Error(`question ${id} is already ${ask.state}`);
    return ask;
  }

  private closeAsk(ask: Ask, how: "answered" | "dismissed"): Ask {
    const at = this.now();
    this.db.prepare("UPDATE asks SET closed_at = ?, closed_how = ? WHERE id = ? AND closed_how IS NULL").run(at, how, ask.id);
    return { ...ask, state: how, closedAt: at };
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
      // looked at again; each thread remembers how far it has been answered.
      for (const t of threads) await this.answer(t);
      this.db.prepare("INSERT INTO state (k, v) VALUES ('cursor', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(cursor);
    }
  }

  private async answer(threadId: string): Promise<void> {
    // Messages can arrive while the model is working; go round again for them.
    for (let round = 0; round < ROUNDS; round++) if (!(await this.answerOnce(threadId))) return;
  }

  // Returns true when the thread should be looked at again straight away.
  private async answerOnce(threadId: string): Promise<boolean> {
    const thread = this.node.threads().find((t) => t.id === threadId);
    if (!thread || thread.openedByMe) return false;
    const cfg = this.config(thread.contact);
    if (!cfg.enabled) return false;
    const contact = this.node.contact(thread.contact);
    const applied = () => this.node.log(threadId).filter((e) => e.status === "applied");
    const isDesk = (e: { mine: boolean; body: unknown }): boolean => e.mine && (e.body as { via?: string }).via === "frontdesk";
    const log = applied();

    this.db.prepare("INSERT OR IGNORE INTO thread_use (thread_id) VALUES (?)").run(threadId);
    const use = this.db.prepare("SELECT answered_ord, posting_ord FROM thread_use WHERE thread_id = ?").get(threadId) as { answered_ord: number; posting_ord: number | null };
    const setAnswered = (ord: number): void => {
      this.db.prepare("UPDATE thread_use SET answered_ord = MAX(answered_ord, ?), posting_ord = NULL WHERE thread_id = ?").run(ord, threadId);
    };
    // A crash between posting a reply and noting it: if the reply is in the log, it counts.
    if (use.posting_ord !== null) {
      if (log.some((e) => isDesk(e) && e.ord! > use.posting_ord!)) use.answered_ord = Math.max(use.answered_ord, use.posting_ord);
      setAnswered(use.answered_ord);
    }

    const waiting = log.filter((e) => !e.mine && e.type === "talk.posted" && e.ord! > use.answered_ord);
    if (waiting.length === 0) return false;
    const inputOrd = log.at(-1)!.ord!;
    const ownerSpokeAfter = (ord: number): boolean => applied().some((e) => e.mine && !isDesk(e) && e.type === "talk.posted" && e.ord! > ord);
    if (ownerSpokeAfter(waiting.at(-1)!.ord!)) {
      setAnswered(inputOrd);
      return false;
    }

    const started = this.now();
    const record = (outcome: Run["outcome"], extra: { bundleHash?: string; files?: string[]; replyEventId?: string; detail?: string } = {}): void => {
      this.db
        .prepare("INSERT INTO runs (at, contact_root, thread_id, outcome, bundle_hash, files, reply_event_id, ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(started, contact.rootKey, threadId, outcome, extra.bundleHash ?? null, JSON.stringify(extra.files ?? []), extra.replyEventId ?? null, this.now() - started, extra.detail ?? null);
      this.onRun({ outcome, contact: contact.name, threadId, detail: extra.detail ?? null });
    };
    const post = async (text: string): Promise<string> => {
      this.db.prepare("UPDATE thread_use SET posting_ord = ? WHERE thread_id = ?").run(inputOrd, threadId);
      const e = await this.node.say(threadId, text, "frontdesk");
      setAnswered(inputOrd);
      return e.id;
    };

    const slot = this.takeSlot(contact.rootKey, threadId, cfg);
    if (slot === "none") {
      setAnswered(inputOrd);
      return false;
    }
    if (slot === "last-notice") {
      record("out_of_budget", { replyEventId: await post(TEXT.outOfBudget(cfg.owner)) });
      return false;
    }

    const bundle = readBundle(this.node.home, contact.name);
    if (bundle.files.length === 0) {
      record("no_material", { replyEventId: await post(TEXT.noMaterial(cfg.owner)) });
      return false;
    }

    let raw: string;
    try {
      raw = await this.model({ system: systemPrompt(cfg.owner, contact.name, bundle), prompt: userPrompt(contact.name, thread.goal, log) });
    } catch (e) {
      // The slot stays spent: a peer must not get free retries by making the model fail.
      record("failed", { bundleHash: bundle.hash, detail: (e as Error).message.slice(0, 300) });
      setAnswered(inputOrd);
      return false;
    }

    // The owner may have turned the desk off or changed what is shared while
    // the model was working. An answer made under the old rules is not sent.
    if (!this.config(contact.name).enabled || readBundle(this.node.home, contact.name).hash !== bundle.hash) {
      record("failed", { bundleHash: bundle.hash, detail: "sharing changed while answering; reply dropped" });
      return true;
    }
    if (ownerSpokeAfter(inputOrd)) {
      record("failed", { bundleHash: bundle.hash, detail: "owner replied first" });
      setAnswered(applied().at(-1)!.ord!);
      return false;
    }

    const lines = raw.split("\n");
    const asks = lines.filter((l) => l.trimStart().startsWith(ASK)).map((l) => l.trimStart().slice(ASK.length).trim().slice(0, ASK_CHARS)).filter(Boolean);
    let reply = lines.filter((l) => !l.trimStart().startsWith(ASK)).join("\n").trim();
    const lowered = raw.toLowerCase();
    if (this.forbidden.some((f) => lowered.includes(f))) {
      record("failed", { bundleHash: bundle.hash, detail: "reply contained a private value; dropped" });
      setAnswered(inputOrd);
      return false;
    }
    if (asks.length > 0) reply = reply ? `${reply}\n\n${TEXT.asked(cfg.owner)}` : TEXT.asked(cfg.owner);
    if (!reply) {
      record("failed", { bundleHash: bundle.hash, detail: "empty reply" });
      setAnswered(inputOrd);
      return false;
    }
    if (reply.length > REPLY_CHARS) reply = `${reply.slice(0, REPLY_CHARS)}\n[cut short]`;

    const replyEventId = await post(reply);
    if (asks.length > 0) this.db.prepare("INSERT INTO asks (at, contact_root, thread_id, question) VALUES (?, ?, ?, ?)").run(this.now(), contact.rootKey, threadId, asks[0]!);
    record(asks.length > 0 ? "asked_human" : "answered", { bundleHash: bundle.hash, files: bundle.files.map((f) => f.name).filter((n) => reply.includes(n)), replyEventId });
    return true;
  }

  // "slot": go ahead. "last-notice": budget just ran out, say so once. "none": stay silent.
  // Notices are capped per day as well, so opening many threads earns nothing.
  private takeSlot(contactRoot: string, threadId: string, cfg: DeskConfig): "slot" | "last-notice" | "none" {
    const day = Math.floor(this.now() / DAY);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO day_use (contact_root, day) VALUES (?, ?)").run(contactRoot, day);
      const t = this.db.prepare("SELECT used, notified FROM thread_use WHERE thread_id = ?").get(threadId) as { used: number; notified: number };
      const d = this.db.prepare("SELECT used, notices FROM day_use WHERE contact_root = ? AND day = ?").get(contactRoot, day) as { used: number; notices: number };
      let out: "slot" | "last-notice" | "none";
      if (t.used < cfg.slotsPerThread && d.used < cfg.slotsPerDay) {
        this.db.prepare("UPDATE thread_use SET used = used + 1 WHERE thread_id = ?").run(threadId);
        this.db.prepare("UPDATE day_use SET used = used + 1 WHERE contact_root = ? AND day = ?").run(contactRoot, day);
        out = "slot";
      } else if (!t.notified && d.notices < NOTICES_PER_DAY) {
        this.db.prepare("UPDATE thread_use SET notified = 1 WHERE thread_id = ?").run(threadId);
        this.db.prepare("UPDATE day_use SET notices = notices + 1 WHERE contact_root = ? AND day = ?").run(contactRoot, day);
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

interface AskRow {
  id: number;
  at: number;
  contact_root: string;
  thread_id: string;
  question: string;
  closed_at: number | null;
  closed_how: "answered" | "dismissed" | null;
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
