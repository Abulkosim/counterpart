import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Counterpart, isHeld } from "@counterpart/daemon";
import { ASK_CHARS, type Material, REPLY_CHARS, TEXT, compose, queryFrom, unchanged } from "./answer.ts";
import { type Model, type ModelSetup, ModelError } from "./model.ts";
import { Preparer } from "./offload.ts";
import { userPrompt } from "./prompt.ts";

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
  // Why the desk passed it on without trying, when something on this machine
  // failed. Written by code, never by the model or the contact.
  reason: string | null;
}

// The model has failed since `since`, and has not run since. Cleared by the
// next call that works.
export interface Health {
  since: number;
  last: number;
  short: string; // a fixed phrase, safe for a status line
  detail: string; // may name local paths; for the owner only
}

export interface CheckResult {
  ok: boolean;
  short: string | null;
  detail: string | null;
  setup: ModelSetup | null;
}

// A tiny call that shows the model can run from the daemon's environment.
const CHECK = { system: "This is a check that you can be reached. Reply with the word ok and nothing else.", prompt: "ok?" };
export const CHECK_TIMEOUT_MS = 60_000;
// A check request older than this is not run: whoever asked has given up.
const CHECK_STALE_MS = 2 * 60_000;
// Goes on the status line and in `cpart asks`, so it is always a phrase code
// chose. Any other error's message could carry text from a response; that
// stays in the detail, which only the owner's own commands and log show.
const shortOf = (e: Error): string => (e instanceof ModelError ? e.short : e.name === "TimeoutError" ? "the model timed out" : "the model call failed");

const DAY = 24 * 3600 * 1000;
const NOTICES_PER_DAY = 3;
const ROUNDS = 3;
// How long the desk waits, after a contact opens a thread and sends nothing,
// before it takes the goal as the question. Agents often open a thread and
// send their first message one model turn later; this keeps the desk from
// answering the goal and then the message.
export const GOAL_WAIT_MS = 20_000;
// Only a goal with a question mark is taken as a question. Agents are told to
// make the goal a short title, like "Orders API", and to ask in a message; a
// title answered on its own gets a reply that answers nothing and passes the
// owner a question nobody asked.
export const goalAsks = (goal: string): boolean => /[?\uff1f\u061f]/.test(goal);

// Answers a contact's questions while the owner is away, from the approved
// bundle or the files the owner shared from a repository, nothing else. It replies in threads the contact opened, never in ones the
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
  private preparer: Preparer;
  private closed = false;
  private goalWaitMs: number;
  private setup: () => ModelSetup | null;
  private checkTimer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;
  onError: (e: Error) => void = () => {};
  // Called after each run is recorded, so the daemon can log it.
  onRun: (run: { outcome: Run["outcome"]; contact: string; threadId: string; detail: string | null }) => void = () => {};
  // Called after each check the owner asked for.
  onCheck: (c: CheckResult) => void = () => {};

  // `forbidden` are exact strings that must never appear in a reply, such as
  // values the model runtime adds to its own context. A reply containing one is
  // dropped. This catches accidents and plain leaks, not a determined encoder.
  // `setup` says where the model runs from, for the owner when a check fails.
  constructor(node: Counterpart, model: Model, opts: { now?: () => number; forbidden?: string[]; prepareTimeoutMs?: number; goalWaitMs?: number; setup?: () => ModelSetup } = {}) {
    this.goalWaitMs = opts.goalWaitMs ?? GOAL_WAIT_MS;
    this.setup = opts.setup ?? (() => null);
    this.preparer = new Preparer(opts.prepareTimeoutMs !== undefined ? { timeoutMs: opts.prepareTimeoutMs } : {});
    this.forbidden = (opts.forbidden ?? []).filter((f) => f.length >= 4).map((f) => f.toLowerCase());
    this.node = node;
    this.model = model;
    this.now = opts.now ?? Date.now;
    this.db = new DatabaseSync(join(node.home, "frontdesk.db"));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
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
      CREATE TABLE IF NOT EXISTS goal_wait (thread_id TEXT PRIMARY KEY, due INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, contact_root TEXT NOT NULL, thread_id TEXT NOT NULL,
        outcome TEXT NOT NULL, bundle_hash TEXT, files TEXT NOT NULL, reply_event_id TEXT, ms INTEGER NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS asks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, contact_root TEXT NOT NULL, thread_id TEXT NOT NULL, question TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS health (
        id INTEGER PRIMARY KEY CHECK (id = 1), since INTEGER NOT NULL, last INTEGER NOT NULL, short TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, started_at INTEGER, done_at INTEGER, ok INTEGER, short TEXT, detail TEXT, setup TEXT
      );
    `);
    // Columns added after the table first shipped.
    const cols = (this.db.prepare("PRAGMA table_info(asks)").all() as unknown as { name: string }[]).map((c) => c.name);
    if (!cols.includes("closed_at")) this.db.exec("ALTER TABLE asks ADD COLUMN closed_at INTEGER; ALTER TABLE asks ADD COLUMN closed_how TEXT;");
    try {
      if (!cols.includes("reason")) this.db.exec("ALTER TABLE asks ADD COLUMN reason TEXT;");
    } catch (e) {
      // The daemon and a command can open the file at the same moment.
      if (!/duplicate column/i.test((e as Error).message)) throw e;
    }
  }

  close(): void {
    this.closed = true;
    this.preparer.close();
    this.db.close();
  }

  // ---- configuration, set only by the owner ----

  // What configure() would set, or the reason it would refuse. Writes nothing.
  validate(contactName: string, patch: Partial<Omit<DeskConfig, "contact">>): DeskConfig {
    const next = { ...this.config(contactName), ...patch };
    if (!Number.isInteger(next.slotsPerThread) || next.slotsPerThread < 1 || next.slotsPerThread > 100) throw new Error("replies per thread must be 1-100");
    if (!Number.isInteger(next.slotsPerDay) || next.slotsPerDay < 1 || next.slotsPerDay > 1000) throw new Error("replies per day must be 1-1000");
    if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(next.owner)) throw new Error("owner name: 1-40 letters, digits, spaces, dot, dash, underscore");
    return next;
  }

  configure(contactName: string, patch: Partial<Omit<DeskConfig, "contact">>): DeskConfig {
    const c = this.node.contact(contactName);
    const next = this.validate(c.name, patch);
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
      reason: r.reason ?? null,
    }));
  }

  // ---- whether the model can run ----

  // Null while the model works, or before it was ever called.
  health(): Health | null {
    return (this.db.prepare("SELECT since, last, short, detail FROM health WHERE id = 1").get() as Health | undefined) ?? null;
  }

  private failing(e: Error): void {
    const now = this.now();
    this.db
      .prepare("INSERT INTO health (id, since, last, short, detail) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET last = excluded.last, short = excluded.short, detail = excluded.detail")
      .run(now, now, shortOf(e), e.message.slice(0, 500));
  }

  private working(): void {
    this.db.prepare("DELETE FROM health").run();
  }

  // Called by the owner's command line: asks the daemon, which runs this desk
  // with its own environment, to make one tiny model call. Returns an id for
  // checkResult().
  requestCheck(): number {
    return Number(this.db.prepare("INSERT INTO checks (at) VALUES (?)").run(this.now()).lastInsertRowid);
  }

  // Withdraw a request no daemon has taken, so one started later does not run it.
  cancelCheck(id: number): void {
    this.db.prepare("DELETE FROM checks WHERE id = ? AND started_at IS NULL").run(id);
  }

  // True while the daemon runs a check. It runs one at a time, so a request
  // made meanwhile waits for it.
  checkBusy(): boolean {
    return !!this.db.prepare("SELECT 1 FROM checks WHERE started_at IS NOT NULL AND done_at IS NULL AND at > ?").get(this.now() - CHECK_STALE_MS);
  }

  // "waiting": no daemon has taken it yet. "running": taken, not finished.
  checkResult(id: number): "waiting" | "running" | CheckResult {
    const r = this.db.prepare("SELECT * FROM checks WHERE id = ?").get(id) as CheckRow | undefined;
    if (!r || r.started_at === null) return "waiting";
    if (r.done_at === null) return "running";
    this.db.prepare("DELETE FROM checks WHERE id = ? OR at < ?").run(id, this.now() - CHECK_STALE_MS);
    return { ok: r.ok === 1, short: r.short, detail: r.detail, setup: r.setup ? (JSON.parse(r.setup) as ModelSetup) : null };
  }

  // Make one tiny model call here and now.
  async check(): Promise<CheckResult> {
    const setup = this.setup();
    try {
      const text = await this.model({ ...CHECK, timeoutMs: CHECK_TIMEOUT_MS });
      if (!text.trim()) throw new ModelError("the model gave an empty answer");
      if (!this.closed) this.working();
      return { ok: true, short: null, detail: null, setup };
    } catch (e) {
      if (!this.closed) this.failing(e as Error);
      return { ok: false, short: shortOf(e as Error), detail: (e as Error).message.slice(0, 500), setup };
    }
  }

  // Run the oldest check request that nobody has taken. One at a time.
  private serveChecks(): void {
    if (this.checking || this.closed) return;
    const r = this.db.prepare("SELECT id FROM checks WHERE started_at IS NULL AND at > ? ORDER BY id LIMIT 1").get(this.now() - CHECK_STALE_MS) as { id: number } | undefined;
    if (!r) return;
    this.db.prepare("UPDATE checks SET started_at = ? WHERE id = ?").run(this.now(), r.id);
    this.checking = this.check()
      .then((c) => {
        if (!this.closed) this.db.prepare("UPDATE checks SET done_at = ?, ok = ?, short = ?, detail = ?, setup = ? WHERE id = ?").run(this.now(), c.ok ? 1 : 0, c.short, c.detail, c.setup ? JSON.stringify(c.setup) : null, r.id);
        this.onCheck(c);
      })
      .catch((e: Error) => this.onError(e))
      .finally(() => {
        this.checking = null;
      });
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
    // Checks run beside answering, so a long answer does not hold one up.
    this.checkTimer = setInterval(() => {
      try {
        this.serveChecks();
      } catch (e) {
        this.onError(e as Error);
      }
    }, intervalMs);
    return this;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.timer = null;
    this.checkTimer = null;
    await Promise.all([this.running.catch(() => {}), this.checking]);
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
      if (batch.length === 0) break;
      const threads = new Set<string>();
      for (const e of batch) {
        if (!e.mine && e.type === "talk.posted") threads.add(e.threadId);
        // A thread the contact opened while the desk was on for them: if no
        // message follows, a goal that asks something is the question.
        if (!e.mine && e.type === "thread.opened" && this.waitsForGoal(e.threadId)) this.db.prepare("INSERT OR IGNORE INTO goal_wait (thread_id, due) VALUES (?, ?)").run(e.threadId, this.now() + this.goalWaitMs);
        cursor = e.ord!;
      }
      // If we crash mid-batch the cursor has not moved and these threads are
      // looked at again; each thread remembers how far it has been answered.
      for (const t of threads) await this.answer(t);
      this.db.prepare("INSERT INTO state (k, v) VALUES ('cursor', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(cursor);
    }
    // Threads whose wait is over. One where a message came meanwhile was
    // answered above and has nothing left to answer. The row goes only after
    // the answer, so a crash in between looks at the thread again.
    const due = this.db.prepare("SELECT thread_id FROM goal_wait WHERE due <= ? ORDER BY due").all(this.now()) as { thread_id: string }[];
    for (const { thread_id } of due) {
      if (this.closed) return;
      await this.answer(thread_id, true);
      this.db.prepare("DELETE FROM goal_wait WHERE thread_id = ?").run(thread_id);
    }
  }

  private waitsForGoal(threadId: string): boolean {
    const t = this.node.threads().find((x) => x.id === threadId);
    return !!t && !t.openedByMe && goalAsks(t.goal) && this.config(t.contact).enabled;
  }

  private async answer(threadId: string, goalDue = false): Promise<void> {
    // Messages can arrive while the model is working; go round again for them.
    for (let round = 0; round < ROUNDS; round++) if (!(await this.answerOnce(threadId, goalDue))) return;
  }

  // Returns true when the thread should be looked at again straight away.
  // `goalDue`: the contact opened this thread a while ago; if they have sent
  // nothing since, the goal is taken as their question.
  private async answerOnce(threadId: string, goalDue: boolean): Promise<boolean> {
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
    // The goal counts as the question only when the thread holds nothing else
    // from the contact: no message, no proposal. It is untrusted text from the
    // contact, like a message, and takes a slot like one.
    const opened = log.find((e) => e.type === "thread.opened");
    const goalOnly = waiting.length === 0 && goalDue && goalAsks(thread.goal) && !!opened && !opened.mine && opened.ord! > use.answered_ord && log.filter((e) => !e.mine).length === 1;
    if (waiting.length === 0 && !goalOnly) return false;
    const question = goalOnly ? opened! : waiting.at(-1)!;
    const inputOrd = log.at(-1)!.ord!;
    const ownerSpokeAfter = (ord: number): boolean => applied().some((e) => e.mine && !isDesk(e) && e.type === "talk.posted" && e.ord! > ord);
    const theyWroteAfter = (ord: number): boolean => applied().some((e) => !e.mine && e.type === "talk.posted" && e.ord! > ord);
    if (ownerSpokeAfter(question.ord!)) {
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

    const latest = goalOnly ? thread.goal : (question.body as { text: string }).text;
    // Something on this machine failed. The reason goes to the owner in the
    // run record and with the question in their asks; the contact is told only
    // that the question was passed on, since the reason may name local paths.
    const passOn = async (reason: string, detail: string, extra: { bundleHash?: string } = {}): Promise<void> => {
      const replyEventId = await post(TEXT.unavailable(cfg.owner));
      this.db
        .prepare("INSERT INTO asks (at, contact_root, thread_id, question, reason) VALUES (?, ?, ?, ?, ?)")
        .run(this.now(), contact.rootKey, threadId, latest.replace(/\s+/g, " ").trim().slice(0, ASK_CHARS) || "(an empty message)", reason);
      record("failed", { replyEventId, detail, ...extra });
    };
    let material: Material | null;
    try {
      material = await this.preparer.run(this.node.home, contact, cfg.owner, queryFrom(thread.goal, log));
    } catch (e) {
      // A shared repository that moved, cannot be read, or took too long.
      if (this.closed || !this.config(contact.name).enabled) return false;
      await passOn("the shared files could not be read", `could not read what is shared: ${(e as Error).message.slice(0, 250)}`);
      return false;
    }
    if (!material) {
      record("no_material", { replyEventId: await post(TEXT.noMaterial(cfg.owner)) });
      return false;
    }

    let raw: string;
    try {
      raw = await this.model({ system: material.system, prompt: userPrompt(contact.name, thread.goal, log, goalOnly) });
    } catch (e) {
      // The model could not run: not logged in, not found, timed out. The slot
      // stays spent and the message is not tried again, so a peer gets no free
      // retries by making the model fail, and nothing loops. The contact hears
      // that the question was passed on; the owner gets it in their asks.
      if (this.closed) return false;
      this.failing(e as Error);
      setAnswered(inputOrd);
      const detail = (e as Error).message.slice(0, 300);
      if (!this.config(contact.name).enabled || ownerSpokeAfter(question.ord!)) {
        record("failed", { bundleHash: material.hash, detail });
        return false;
      }
      await passOn(`the model could not run (${shortOf(e as Error)})`, detail, { bundleHash: material.hash });
      return false;
    }
    if (!this.closed) this.working();

    // The owner may have turned the desk off or changed what is shared while
    // the model was working. An answer made under the old rules is not sent.
    if (!this.config(contact.name).enabled || !unchanged(this.node.home, contact, material)) {
      record("failed", { bundleHash: material.hash, detail: "sharing changed while answering; reply dropped" });
      return true;
    }
    if (ownerSpokeAfter(inputOrd)) {
      record("failed", { bundleHash: material.hash, detail: "owner replied first" });
      setAnswered(applied().at(-1)!.ord!);
      return false;
    }
    // The contact sent a message while the goal was being answered. Answer
    // that instead, with the goal still in view, so they get one reply, not two.
    // The slot stays spent, as for any run.
    if (goalOnly && theyWroteAfter(inputOrd)) {
      record("failed", { bundleHash: material.hash, detail: "a message followed the goal; answering that instead" });
      return true;
    }

    const lowered = raw.toLowerCase();
    if (this.forbidden.some((f) => lowered.includes(f))) {
      record("failed", { bundleHash: material.hash, detail: "reply contained a private value; dropped" });
      setAnswered(inputOrd);
      return false;
    }
    const c = compose(material, raw, cfg.owner, latest);
    let reply = c.reply;
    const asks = c.asks;
    if (!reply) {
      record("failed", { bundleHash: material.hash, detail: c.detail ?? "empty reply" });
      setAnswered(inputOrd);
      return false;
    }
    // A checked reply is already cut at a line boundary in compose(); this only
    // ever shortens a bundle reply, which is sent as written anyway.
    if (reply.length > REPLY_CHARS) reply = `${reply.slice(0, REPLY_CHARS)}\n[cut short]`;

    let replyEventId: string;
    try {
      replyEventId = await post(reply);
    } catch (e) {
      // The outbound guard held the reply. It waits for the owner in `cpart held`.
      if (!isHeld(e)) throw e;
      record("failed", { bundleHash: material.hash, detail: `reply held by the outbound guard (${e.reasons.join(", ")}); see cpart held` });
      setAnswered(inputOrd);
      return false;
    }
    if (asks.length > 0) this.db.prepare("INSERT INTO asks (at, contact_root, thread_id, question) VALUES (?, ?, ?, ?)").run(this.now(), contact.rootKey, threadId, asks[0]!);
    record(asks.length > 0 ? "asked_human" : "answered", { bundleHash: material.hash, files: c.files, replyEventId, ...(c.detail ? { detail: c.detail } : {}) });
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
  reason: string | null;
}
interface CheckRow {
  started_at: number | null;
  done_at: number | null;
  ok: number | null;
  short: string | null;
  detail: string | null;
  setup: string | null;
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
