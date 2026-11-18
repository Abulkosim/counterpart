// Pairing with a short code, the daemon's half. The CLI writes a request into
// pairing.db in the home; the daemon, which holds the relay connection, runs
// it and writes back how it went. Nothing here trusts the relay: it carries
// the messages, and InviterRun and JoinerRun (protocol/pake-pairing.ts) decide.
//
// After both sides have confirmed the key, the inviter makes an ordinary
// invite, good only for the root key that proved the code, and seals it to the
// joiner. The joiner accepts it the usual way. From there on it is the normal
// contact.request and contact.accepted.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type PairCode, type PairFailure, type PairMsg, type PairServerFrame, InviterRun, JoinerRun, NAMEPLATE_MAX, PAIR_BODY_MAX, canonicalize, decodeInvite, encodePairMsg, formatCode,
  isObject, pairFailureText, parsePairMsg, randomId, randomWords,
} from "@counterpart/protocol";
import type { RelayLink } from "./link.ts";
import { type Counterpart, checkName } from "./node.ts";

const HOUR = 3600_000;
const REQUEST_RETRY = 10_000; // ask the relay again if it has not answered
const REQUEST_TRIES = 3; // then give up: the relay may not know about nameplates
const INVITE_TTL = HOUR; // the sealed invite; the joiner's daemon uses it within seconds
const JOIN_WAIT = 10 * 60_000; // a joiner waits this long for the inviter's first message

// The start of the sentence when the relay never answered a pair.* frame. The
// CLI looks for it to offer the long invite instead.
export const OLD_RELAY = "The relay did not answer. It may be an older version without short codes.";

// What a home remembers of a code it has answered: a hash, so the same code is
// never answered twice from here.
const codeHash = (relay: string, nameplate: number, words: string): string =>
  createHash("sha256").update(canonicalize({ relay, nameplate, words: words.split("-") })).digest("base64url");

export type PairingRole = "inviter" | "joiner";
// requested: written by the CLI. open: an inviter's code is live. claiming,
// claimed, answered: a joiner's progress. confirmed: both sides proved the
// code; the ordinary contact request is on its way. done, failed: the end.
export type PairingState = "requested" | "open" | "claiming" | "claimed" | "answered" | "confirmed" | "done" | "failed";

export interface PairingView {
  id: string;
  role: PairingRole;
  name: string;
  relay: string;
  nameplate: number | null;
  code: string | null; // the inviter's code, while it can still be used
  state: PairingState;
  detail: string | null; // a sentence for a person
  claimed: boolean; // inviter: someone has taken the nameplate
  peerRoot: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface Row {
  id: string;
  role: PairingRole;
  name: string;
  relay: string;
  nameplate: number | null;
  words: string | null;
  state: PairingState;
  detail: string | null;
  claimed: number;
  peer_root: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

const TERMINAL = new Set<PairingState>(["done", "failed"]);

// The table both the CLI and the daemon use. The words of a live code sit here
// (in the private home) until the pairing ends. Then the row is cleared, freed
// pages are zeroed (secure_delete), and the daemon checkpoints the write-ahead
// log so the old pages do not stay in pairing.db-wal either.
export class PairingStore {
  private db: DatabaseSync;
  private now: () => number;
  private dirty = false; // words were cleared and the log still holds them

  constructor(home: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    const file = join(home, "pairing.db");
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS pairings (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, relay TEXT NOT NULL, nameplate INTEGER, words TEXT,
        state TEXT NOT NULL, detail TEXT, claimed INTEGER NOT NULL DEFAULT 0, peer_root TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tried (hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  requestInvite(name: string, relay: string): string {
    checkName(name);
    const id = randomId();
    const t = this.now();
    this.db.prepare("INSERT INTO pairings (id, role, name, relay, state, created_at, updated_at, expires_at) VALUES (?, 'inviter', ?, ?, 'requested', ?, ?, ?)").run(id, name, relay, t, t, t + 60_000);
    return id;
  }

  // A code is answered once from a home. Answering it again would give whoever
  // runs the other end, the relay included, a second guess. It is recorded as
  // tried when the daemon answers (answered()), so a failure that spent no guess
  // (rate limited, relay unreachable) leaves the code usable.
  requestJoin(code: PairCode, name: string, relay: string): string {
    checkName(name);
    const words = code.words.join("-");
    const hash = codeHash(relay, code.nameplate, words);
    const id = randomId();
    const t = this.now();
    this.tx(() => {
      if (this.db.prepare("SELECT 1 FROM tried WHERE hash = ?").get(hash)) throw new Error("this code was already tried here, and a code works once. Ask for a new one");
      if (this.db.prepare("SELECT 1 FROM pairings WHERE role = 'joiner' AND relay = ? AND nameplate = ? AND words = ? AND state NOT IN ('done', 'failed')").get(relay, code.nameplate, words)) {
        throw new Error("this code is being tried here already. See how it goes with: cpart status");
      }
      this.db
        .prepare("INSERT INTO pairings (id, role, name, relay, nameplate, words, state, created_at, updated_at, expires_at) VALUES (?, 'joiner', ?, ?, ?, ?, 'requested', ?, ?, ?)")
        .run(id, name, relay, code.nameplate, words, t, t, t + JOIN_WAIT);
    });
    return id;
  }

  // The joiner is about to answer: record the code as tried, in the same
  // transaction. False if it was answered from here before; then do not answer.
  answered(r: Row, peerRoot: string): boolean {
    const hash = codeHash(r.relay, r.nameplate!, r.words!);
    let ok = false;
    this.tx(() => {
      if (this.db.prepare("SELECT 1 FROM tried WHERE hash = ?").get(hash)) return;
      this.db.prepare("INSERT INTO tried (hash, at) VALUES (?, ?)").run(hash, this.now());
      this.db.prepare("UPDATE pairings SET state = 'answered', peer_root = ?, updated_at = ? WHERE id = ?").run(peerRoot, this.now(), r.id);
      ok = true;
    });
    return ok;
  }

  get(id: string): PairingView | undefined {
    const r = this.db.prepare("SELECT * FROM pairings WHERE id = ?").get(id) as Row | undefined;
    return r && view(r);
  }

  recent(sinceMs = HOUR): PairingView[] {
    return (this.db.prepare("SELECT * FROM pairings WHERE updated_at > ? OR state NOT IN ('done', 'failed') ORDER BY created_at").all(this.now() - sinceMs) as unknown as Row[]).map(view);
  }

  // For the engine.
  row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM pairings WHERE id = ?").get(id) as Row | undefined;
  }
  live(): Row[] {
    return this.db.prepare("SELECT * FROM pairings WHERE state NOT IN ('done', 'failed')").all() as unknown as Row[];
  }
  set(id: string, f: Partial<Pick<Row, "nameplate" | "words" | "state" | "detail" | "claimed" | "peer_root" | "expires_at">>): void {
    const t = this.now();
    const fields = Object.entries(f);
    // The secret goes when the pairing ends.
    if (f.state && TERMINAL.has(f.state)) {
      fields.push(["words", null]);
      this.dirty = true;
    }
    this.db.prepare(`UPDATE pairings SET ${fields.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...fields.map(([, v]) => v as string | number | null), t, id);
  }
  // Copy the log into the database and empty it, so cleared words are not left
  // in pairing.db-wal. A reader (a waiting CLI) can hold it up; then the next
  // call tries again.
  wipe(): void {
    if (!this.dirty) return;
    const r = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
    if (r && r.busy === 0) this.dirty = false;
  }
  // Old rows are kept a day so `cpart status` can say how a pairing ended.
  prune(): void {
    this.db.prepare("DELETE FROM pairings WHERE state IN ('done', 'failed') AND updated_at < ?").run(this.now() - 24 * HOUR);
    this.db.prepare("DELETE FROM tried WHERE at < ?").run(this.now() - 30 * 24 * HOUR);
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

function view(r: Row): PairingView {
  return {
    id: r.id, role: r.role, name: r.name, relay: r.relay, nameplate: r.nameplate,
    code: r.role === "inviter" && r.state === "open" && r.nameplate && r.words ? formatCode(r.nameplate, r.words.split("-")) : null,
    state: r.state, detail: r.detail, claimed: !!r.claimed, peerRoot: r.peer_root, createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at,
  };
}

const ERRORS: Record<string, string> = {
  nameplate_unknown: "No code with that number is waiting on this relay. It may have expired or been used already. Ask for a new one.",
  nameplate_taken: "Someone else already used this code. Nothing was paired. Ask for a new one.",
  nameplate_own: "That is your own code. Nothing was paired.",
  rate_limited: "Too many codes made or tried from this device in the last hour. Wait a while, or use the long invite: cpart invite <name> --long",
  relay_full: "The relay has no room for another code right now. Try again later, or use the long invite: cpart invite <name> --long",
};

interface Live {
  inviter?: InviterRun;
  joiner?: JoinerRun;
}

// Runs inside `cpart daemon`, next to the RelayLink.
export class PairingEngine {
  private node: Counterpart;
  private link: RelayLink;
  private store: PairingStore;
  private now: () => number;
  private pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private runs = new Map<string, Live>(); // by pairing id, in memory only
  private asked = new Map<string, { at: number; tries: number }>(); // open and claim requests sent
  private seen = new Set<string>(); // relay message keys already handled
  // What each live pairing has sent, to send again after a reconnect: a message
  // lost with a dropped connection would otherwise stall the pairing. The relay
  // treats the same message twice as one.
  private sent = new Map<string, { nameplate: number; bodies: string[] }>();
  private pending = new Set<Promise<unknown>>();
  // Nameplates of runs a restart ended. The other side is told on the first
  // connection, so it does not wait for a run that cannot finish.
  private ended: number[] = [];
  onLine: (line: string) => void = () => {};

  constructor(node: Counterpart, link: RelayLink, opts: { now?: () => number; pollMs?: number; store?: PairingStore } = {}) {
    this.node = node;
    this.link = link;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 250;
    this.store = opts.store ?? new PairingStore(node.home, { now: this.now });
  }

  start(): this {
    // A run's secrets live in memory. If the daemon stopped in the middle of one,
    // that pairing cannot finish; say so rather than leave it hanging.
    for (const r of this.store.live()) {
      if ((r.role === "inviter" && r.state === "open") || (r.role === "joiner" && r.state === "answered")) {
        this.fail(r, "The daemon restarted during the pairing. Nothing was paired. Make a new code.");
        if (r.nameplate) this.ended.push(r.nameplate);
      }
      // Stopped between proving the code and adding the contact: the invite was
      // in memory only, so this cannot finish.
      if (r.role === "joiner" && r.state === "confirmed" && !this.node.contacts().some((c) => c.rootKey === r.peer_root)) {
        this.fail(r, "The daemon stopped while adding the contact. Nothing was paired. Ask for a new code.");
        if (r.nameplate) this.ended.push(r.nameplate);
      }
    }
    this.link.on("pair", this.onFrame);
    this.link.on("homeReady", this.onReady);
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
    return this;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.link.off("pair", this.onFrame);
    this.link.off("homeReady", this.onReady);
    // A contact being added finishes before the store closes.
    await Promise.allSettled([...this.pending]);
    this.store.wipe();
    this.store.close();
  }

  private say(r: Pick<Row, "id">, nameplate: number, m: PairMsg): void {
    const body = encodePairMsg(m);
    const s = this.sent.get(r.id) ?? { nameplate, bodies: [] };
    s.bodies.push(body);
    this.sent.set(r.id, s);
    this.link.sendPair({ t: "pair.send", nameplate, body });
  }

  private onReady = (): void => {
    for (const n of this.ended.splice(0)) {
      this.link.sendPair({ t: "pair.send", nameplate: n, body: encodePairMsg({ v: 1, k: "fail", why: "refused" }) });
      this.link.sendPair({ t: "pair.close", nameplate: n });
    }
    // After a reconnect, ask again at once for what has not been answered. The
    // count of tries is kept: a relay without nameplates closes the connection
    // on every pair.* frame, and counting from zero after each reconnect would
    // retry in a tight loop for as long as the code lives.
    for (const a of this.asked.values()) a.at = 0;
    const live = new Set<string>();
    for (const r of this.store.live()) {
      live.add(r.id);
      if (r.role === "joiner" && (r.state === "claimed" || r.state === "answered") && r.nameplate) this.link.sendPair({ t: "pair.claim", nameplate: r.nameplate });
      const s = this.sent.get(r.id);
      if (s) for (const body of s.bodies) this.link.sendPair({ t: "pair.send", nameplate: s.nameplate, body });
    }
    for (const id of this.sent.keys()) if (!live.has(id)) this.sent.delete(id);
    this.tick();
  };

  private log(r: Pick<Row, "name" | "role">, line: string): void {
    this.onLine(`pairing ${r.role === "inviter" ? "for" : "with"} ${r.name}: ${line}`);
  }

  // Per-run memory goes when a pairing ends, however it ends.
  private forget(id: string): void {
    this.runs.delete(id);
    this.sent.delete(id);
    this.asked.delete(id);
  }

  private fail(r: Row, detail: string, opts: { tell?: PairFailure; close?: boolean } = {}): void {
    if (r.nameplate && opts.tell) this.say(r, r.nameplate, { v: 1, k: "fail", why: opts.tell });
    if (r.nameplate && opts.close) this.link.sendPair({ t: "pair.close", nameplate: r.nameplate });
    this.store.set(r.id, { state: "failed", detail });
    this.forget(r.id);
    this.log(r, `failed. ${detail}`);
  }

  tick(): void {
    try {
      this.store.prune();
      const t = this.now();
      for (const r of this.store.live()) {
        if (r.relay !== this.node.relayName) {
          this.fail(r, "This pairing names another relay than this identity uses.");
          continue;
        }
        // Paired some other way meanwhile, say with the long invite: the code is not needed.
        if (r.role === "inviter" && (r.state === "requested" || r.state === "open") && this.node.contacts().some((c) => c.name === r.name)) {
          if (r.nameplate) this.link.sendPair({ t: "pair.close", nameplate: r.nameplate });
          this.store.set(r.id, { state: "done", detail: "paired another way; the code was closed" });
          this.forget(r.id);
          continue;
        }
        if (r.state === "confirmed") {
          const c = this.node.contacts().find((x) => x.rootKey === r.peer_root);
          if (c?.state === "active") {
            this.store.set(r.id, { state: "done", detail: null });
            this.forget(r.id);
            this.log(r, "paired");
          } else if (r.expires_at <= t) this.fail(r, `Both sides proved the code, but ${r.name}'s contact request never arrived. Make a new code.`);
          continue;
        }
        if (r.expires_at <= t) {
          this.fail(r, r.role === "inviter" && r.state === "requested" ? "The relay did not give out a code in time." : "The code expired before the pairing finished. Nothing was paired.", { close: true });
          continue;
        }
        if (!this.link.homeOnline || (r.state !== "requested" && r.state !== "claiming")) continue;
        const a = this.asked.get(r.id);
        if (a && t - a.at < REQUEST_RETRY) continue;
        if (a && a.tries >= REQUEST_TRIES) {
          this.fail(r, r.role === "inviter" ? `${OLD_RELAY} Use the long invite: cpart invite ${r.name} --long` : `${OLD_RELAY} Ask ${r.name} for the long invite: cpart invite <your name> --long`);
          continue;
        }
        this.asked.set(r.id, { at: t, tries: (a?.tries ?? 0) + 1 });
        if (r.role === "inviter") this.link.sendPair({ t: "pair.open", ref: r.id });
        else {
          this.store.set(r.id, { state: "claiming" });
          this.link.sendPair({ t: "pair.claim", nameplate: r.nameplate! });
        }
      }
      this.store.wipe();
    } catch (e) {
      this.onLine(`pairing: ${(e as Error).message}`);
    }
  }

  private byPlate(n: unknown, role?: PairingRole): Row | undefined {
    return this.store.live().find((r) => r.nameplate === n && (!role || r.role === role));
  }

  private onFrame = (f: PairServerFrame): void => {
    try {
      this.handle(f as unknown as Record<string, unknown>);
    } catch (e) {
      this.onLine(`pairing: ${(e as Error).message}`);
    }
  };

  private handle(f: Record<string, unknown>): void {
    if (!isObject(f)) return;
    switch (f.t) {
      case "pair.opened": {
        const r = typeof f.ref === "string" ? this.store.row(f.ref) : undefined;
        const n = f.nameplate;
        if (typeof n !== "number" || !Number.isInteger(n)) return;
        if (!r || r.role !== "inviter" || r.state !== "requested") {
          // Not ours, or answered twice: give it back.
          this.link.sendPair({ t: "pair.close", nameplate: n });
          return;
        }
        const words = randomWords();
        const run = new InviterRun({ relay: this.node.relayName, nameplate: n, words, credential: this.node.device.credential, now: this.now });
        this.runs.set(r.id, { inviter: run });
        const expiresAt = typeof f.expiresAt === "number" ? Math.min(f.expiresAt, this.now() + 10 * 60_000) : this.now() + 10 * 60_000;
        this.store.set(r.id, { state: "open", nameplate: n, words: words.join("-"), expires_at: expiresAt });
        this.say(r, n, run.first());
        this.log(r, `code ${n} is live`);
        return;
      }
      case "pair.joined": {
        const r = this.byPlate(f.nameplate, "inviter");
        if (r?.state === "open") this.store.set(r.id, { claimed: 1 });
        return;
      }
      case "pair.claimed": {
        const r = this.byPlate(f.nameplate, "joiner");
        if (r?.state === "claiming") this.store.set(r.id, { state: "claimed" });
        return;
      }
      case "pair.msg":
        return this.onMessage(f);
      case "pair.closed": {
        const r = this.byPlate(f.nameplate);
        if (!r || r.state === "confirmed") return;
        if (r.role === "inviter" && r.state === "requested") return;
        this.fail(r, f.why === "expired" ? "The code expired before the pairing finished. Nothing was paired." : "The other side ended the pairing. Nothing was paired.");
        return;
      }
      case "pair.error": {
        // With a ref it answers an open; otherwise a claim, which only a joiner
        // makes, or a send. An inviter's send to a number the relay no longer
        // has means the code was closed while this side was offline.
        let r = typeof f.ref === "string" ? this.store.row(f.ref) : this.byPlate(f.nameplate, "joiner");
        let text = typeof f.code === "string" ? ERRORS[f.code] : undefined;
        if (!r && f.code === "nameplate_unknown") {
          r = this.byPlate(f.nameplate, "inviter");
          text = "The code was closed on the relay before the pairing finished. Nothing was paired. Make a new code.";
        }
        if (!r || TERMINAL.has(r.state) || !text) return;
        // Errors about a nameplate we are mid-run on are the relay's word only;
        // they can end a run, never complete one.
        if (r.state === "confirmed") return;
        this.fail(r, text);
        return;
      }
    }
  }

  private onMessage(f: Record<string, unknown>): void {
    const { from, nameplate, n, body } = f;
    if (from !== "inviter" && from !== "joiner") return;
    if (typeof nameplate !== "number" || !Number.isInteger(nameplate) || nameplate < 1 || nameplate > NAMEPLATE_MAX) return;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 100 || typeof body !== "string" || body.length > PAIR_BODY_MAX) return;
    const r = this.byPlate(nameplate, from === "joiner" ? "inviter" : "joiner");
    if (!r) return;
    // The relay sends everything again after a reconnect. Each message is handled once.
    const key = `${nameplate}/${from}/${n}/${createHash("sha256").update(body).digest("base64url")}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    let m: PairMsg;
    try {
      m = parsePairMsg(f.body);
    } catch {
      // Malformed. While a run waits for this message, that ends it.
      if ((r.role === "inviter" && r.state === "open") || (r.role === "joiner" && (r.state === "claimed" || r.state === "claiming" || r.state === "answered"))) {
        this.fail(r, pairFailureText("bad-message", r.role), { tell: "bad-message", close: true });
      }
      return;
    }
    if (m.k === "fail") {
      if (r.state === "confirmed") {
        // The joiner proved the code but could not add the contact (or its
        // daemon restarted), so its contact request will not come. Unless it
        // already has: then the pairing is done and the message is late.
        // Unauthenticated like every fail: a relay can end a pairing this way,
        // as it could by dropping the contact request, but not complete one.
        if (r.role !== "inviter" || !r.peer_root || this.node.contacts().some((c) => c.rootKey === r.peer_root)) return;
        this.node.dropInvitesFor(r.peer_root);
      }
      this.fail(r, pairFailureText(m.why, r.role), { close: true });
      return;
    }
    if (r.role === "inviter") this.inviterGot(r, m);
    else this.joinerGot(r, m);
  }

  private inviterGot(r: Row, m: PairMsg): void {
    const run = this.runs.get(r.id)?.inviter;
    if (r.state !== "open" || !run) return; // one answer per code; later ones are not looked at
    const step = run.answer(m);
    if (!step.ok) return this.fail(r, pairFailureText(step.why, "inviter"), { tell: step.why, close: true });
    const known = this.node.contacts().find((c) => c.rootKey === step.peer.rootKey || c.name === r.name);
    if (known) return this.fail(r, known.rootKey === step.peer.rootKey ? `They are already your contact, as ${known.name}. Nothing changed.` : `You already have a contact named ${r.name}. Nothing was paired.`, { tell: "refused", close: true });
    let invite: string;
    try {
      invite = this.node.createInvite(r.name, INVITE_TTL, step.peer.rootKey);
    } catch (e) {
      return this.fail(r, `The code was right, but the contact could not be made: ${(e as Error).message}. Nothing was paired.`, { tell: "refused", close: true });
    }
    this.say(r, r.nameplate!, step.finish(invite));
    // The nameplate stays open until the joiner closes it or it expires, so the
    // last message still reaches a joiner who is briefly offline.
    this.store.set(r.id, { state: "confirmed", peer_root: step.peer.rootKey, detail: null, expires_at: this.now() + INVITE_TTL });
    this.runs.delete(r.id);
    this.log(r, "both sides proved the code; waiting for their contact request");
  }

  private joinerGot(r: Row, m: PairMsg): void {
    if (m.k === "a" && (r.state === "claiming" || r.state === "claimed") && !this.runs.has(r.id)) {
      const run = new JoinerRun({ relay: this.node.relayName, nameplate: r.nameplate!, words: r.words!.split("-"), credential: this.node.device.credential, now: this.now });
      this.runs.set(r.id, { joiner: run });
      const step = run.answer(m);
      if (!step.ok) return this.fail(r, pairFailureText(step.why, "joiner"), { tell: step.why, close: true });
      // What would make adding the contact fail later, checked before the
      // answer spends the code.
      const known = this.node.contacts().find((c) => c.rootKey === step.peer.rootKey || c.name === r.name);
      if (known) return this.fail(r, known.rootKey === step.peer.rootKey ? `They are already your contact, as ${known.name}. Nothing changed.` : `You already have a contact named ${r.name}. Nothing was paired.`, { tell: "refused", close: true });
      if (!this.store.answered(r, step.peer.rootKey)) return this.fail(r, "This code was already tried here, and a code works once. Nothing was paired.", { tell: "refused", close: true });
      this.say(r, r.nameplate!, step.reply);
      return;
    }
    if (m.k === "c" && r.state === "answered") {
      const run = this.runs.get(r.id)?.joiner;
      if (!run) return;
      const step = run.finish(m);
      // One confirmation only, even while the contact is being added below.
      this.runs.delete(r.id);
      if (!step.ok) return this.fail(r, pairFailureText(step.why, "joiner"), { tell: step.why, close: true });
      // The sealed invite must name the same person and relay the code proved.
      try {
        const inv = decodeInvite(step.invite, this.now());
        if (canonicalize(inv.credential) !== canonicalize(step.peer) || inv.relay !== this.node.relayName) throw new Error("mismatch");
      } catch {
        return this.fail(r, pairFailureText("bad-message", "joiner"), { tell: "bad-message", close: true });
      }
      // Confirmed is written first, so nothing the relay says while the contact
      // is being added (a fail, a close, an expiry) can end the pairing.
      this.store.set(r.id, { state: "confirmed", detail: null, expires_at: this.now() + INVITE_TTL });
      const added = this.node.acceptInvite(step.invite, r.name).then(
        () => {
          this.sent.delete(r.id);
          this.link.sendPair({ t: "pair.close", nameplate: r.nameplate! });
          this.log(r, "both sides proved the code; contact request sent");
        },
        (e: Error) => this.fail(r, `Both sides proved the code, but the contact could not be added: ${e.message}`, { tell: "refused", close: true }),
      ).catch((e: Error) => this.onLine(`pairing: ${e.message}`));
      this.pending.add(added);
      void added.finally(() => this.pending.delete(added));
    }
  }
}
