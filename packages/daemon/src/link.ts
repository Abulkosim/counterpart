import { EventEmitter } from "node:events";
import { networkInterfaces } from "node:os";
import WebSocket from "ws";
import { type ClientFrame, type ServerFrame, type ThreadEvent, RELAY_AUTH_DOMAIN, deviceId, isId, isObject, isStr, relayAuthMessage, sign } from "@counterpart/protocol";
import type { Counterpart, Verdict } from "./node.ts";

const MAX_BACKLOG = 256;
const MAX_BUFFERED = 1024 * 1024; // bytes written to a relay and not yet taken by the network
const INFLIGHT_MS = 10_000; // a send the relay has not answered in this time is tried again, on the next relay if there is one
const TWIN_MS = 5000; // see twins()
// A pong or a "stored" can wait behind what we are still uploading. On a slow
// uplink, a large message takes longer than a ping timeout to leave. So each
// byte sent and not yet confirmed adds time at this rate, to the ping timeout
// and to the wait before a send is tried again, up to SLOW_MAX_MS.
const SLOW_BYTES_PER_S = 4096;
const SLOW_MAX_MS = 120_000;
const slowMs = (bytes: number): number => Math.min((bytes / SLOW_BYTES_PER_S) * 1000, SLOW_MAX_MS);

// The relay's error codes are printed and stored. Only plain ones are kept.
const code = (x: unknown): string => (typeof x === "string" && /^[a-z_]{1,32}$/.test(x) ? x : "unknown");

export interface LinkOptions {
  pollMs?: number; // how often the outbox is pumped
  tickMs?: number; // how often pings, sleep and the network are checked
  pingEveryMs?: number; // a connection quiet for this long is pinged
  pingTimeoutMs?: number; // and dropped if the ping is not answered in this time
  loginTimeoutMs?: number; // from dialling to logged in
  backoffMs?: number; // first wait before dialling again
  maxBackoffMs?: number;
  wakeJumpMs?: number; // a tick this late means the machine slept
  fallbackAfterMs?: number; // a contact's relays all down this long: try my others
  watchNetwork?: boolean; // dial again at once when the network interfaces change
}

export interface LinkEvents {
  ready: []; // the first relay is up
  offline: []; // the last relay is down
  relay: [url: string, up: boolean, why: string];
  twin: [url: string, of: string]; // `url` is the same relay as `of`; one connection is kept
  wake: [sleptMs: number];
  network: [];
  event: [ThreadEvent];
  verdict: [Verdict];
  error: [Error];
}

type Route = { preferred: string[]; fallback: string[] };

interface Conn {
  url: string;
  downSince: number; // when it was last logged in, or when it was first dialled
  ws: WebSocket | null;
  ready: boolean;
  appPing: boolean; // the relay answers ping frames; otherwise WebSocket pings
  backoff: number;
  timer: NodeJS.Timeout | null;
  dialledAt: number;
  lastHeard: number;
  pingSentAt: number | null;
  pings: number;
  redialNow: boolean;
  removed: boolean;
  why: string; // why it last went down
  relayId: string | null; // what the relay called itself when last logged in
  replacedAt: number; // when the relay last closed it for a newer login of this device
  aliasOf: string | null; // the same relay as this connection, which is used instead
}

// `event` is a wake-up hint, not a delivery guarantee: a crash between commit
// and emit loses it. Consumers that must not miss events read `node.since(ord)`
// and keep their own cursor.
//
// Keeps one authenticated socket to each of this identity's relays. Pushes the
// outbox up, through a relay the recipient uses, feeds deliveries from every
// relay to the node, and acknowledges a delivery only after the node has
// durably decided what to do with it.
//
// A connection can die without closing: a laptop sleeps, Wi-Fi changes, a
// router forgets the flow. So a quiet connection is pinged and dropped when the
// ping goes unanswered, a machine that slept dials again the moment it wakes,
// and so does one whose network interfaces change. Between attempts the wait
// doubles, with jitter, up to a cap. The outbox is on disk and a message leaves
// it only when a relay says it stored it, so nothing queued is lost.
export class RelayLink extends EventEmitter<LinkEvents> {
  private node: Counterpart;
  private conns = new Map<string, Conn>();
  private stopped = false;
  private poller: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private renewer: NodeJS.Timeout | null = null;
  private renewing: Promise<unknown> | null = null;
  private inflight = new Map<string, { url: string; at: number; bytes: number }>();
  private inbound: Promise<void> = Promise.resolve();
  private backlog = 0;
  private failures = new Map<string, number>();
  private tending = false;
  private wasOnline = false;
  private lastTick = 0;
  private netSig = "";
  private routeCache: { at: number; map: Map<string, Route> } | null = null;
  private o: Required<LinkOptions>;

  constructor(node: Counterpart, opts: LinkOptions = {}) {
    super();
    this.node = node;
    this.o = {
      pollMs: 250, tickMs: 1000, pingEveryMs: 4000, pingTimeoutMs: 4000, loginTimeoutMs: 10_000,
      backoffMs: 250, maxBackoffMs: 15_000, wakeJumpMs: 5000, fallbackAfterMs: 30_000, watchNetwork: true, ...opts,
    };
  }

  start(): this {
    this.stopped = false;
    this.lastTick = Date.now();
    this.netSig = this.o.watchNetwork ? network() : "";
    this.sync();
    this.poller = setInterval(() => {
      this.tend();
      this.pump();
    }, this.o.pollMs);
    this.ticker = setInterval(() => this.tick(), this.o.tickMs);
    // A long-running daemon must renew its credential too, not only at start.
    this.renewer = setInterval(() => void this.renew(), 3600_000);
    this.renewer.unref();
    return this;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of [this.poller, this.ticker, this.renewer]) if (t) clearInterval(t);
    for (const c of this.conns.values()) {
      if (c.timer) clearTimeout(c.timer);
      c.ws?.terminate();
      c.ws = null;
      c.ready = false;
    }
    await this.inbound;
  }

  // Logged in to at least one relay.
  get online(): boolean {
    for (const c of this.conns.values()) if (c.ready) return true;
    return false;
  }

  connected(): string[] {
    return [...this.conns.values()].filter((c) => c.ready).map((c) => c.url);
  }

  // ---- the set of relays

  // Follow the relay list in the database, which `cpart relay` changes from
  // another process.
  private sync(): void {
    let want: string[];
    try {
      want = this.node.relayBook.mine().map((r) => r.url);
    } catch (e) {
      this.emit("error", e as Error);
      return;
    }
    for (const url of want) {
      if (this.conns.has(url)) continue;
      const c: Conn = { url, downSince: Date.now(), ws: null, ready: false, appPing: false, backoff: this.o.backoffMs, timer: null, dialledAt: 0, lastHeard: 0, pingSentAt: null, pings: 0, redialNow: false, removed: false, why: "", relayId: null, replacedAt: 0, aliasOf: null };
      this.conns.set(url, c);
      this.connect(c);
    }
    for (const [url, c] of this.conns) {
      if (want.includes(url)) continue;
      c.removed = true;
      if (c.timer) clearTimeout(c.timer);
      this.conns.delete(url);
      this.drop(c, "removed from your relays");
      this.release(url);
    }
  }

  // ---- one connection

  private renew(): Promise<unknown> {
    // Several connections may ask at once. One renewal, not one per relay.
    this.renewing ??= this.node
      .renewIfDue()
      .catch((e: Error) => this.emit("error", e))
      .finally(() => (this.renewing = null));
    return this.renewing;
  }

  private connect(c: Conn): void {
    c.timer = null;
    // Never log in with a credential that is about to expire.
    void this.renew().finally(() => this.dial(c));
  }

  private dial(c: Conn): void {
    if (this.stopped || c.removed || c.aliasOf || c.ws) return;
    const ws = new WebSocket(c.url, { maxPayload: 1024 * 1024, handshakeTimeout: this.o.loginTimeoutMs });
    c.ws = ws;
    c.dialledAt = Date.now();
    c.lastHeard = c.dialledAt;
    c.pingSentAt = null;
    ws.on("message", (raw) => {
      c.lastHeard = Date.now();
      c.pingSentAt = null;
      let frame: ServerFrame;
      try {
        const x: unknown = JSON.parse(raw.toString());
        if (!isObject(x) || !isStr(x.t)) return;
        frame = x as ServerFrame;
      } catch {
        return;
      }
      // A local failure here (a locked database, say) must not end the process.
      // Drop the socket: the relay sends again and the outbox is pumped again.
      try {
        this.onFrame(c, ws, frame);
      } catch (e) {
        this.emit("error", e as Error);
        this.drop(c, "local error");
      }
    });
    ws.on("pong", () => {
      c.lastHeard = Date.now();
      c.pingSentAt = null;
    });
    ws.on("close", (code) => {
      // 4009: the relay let a newer login of this device in. See twins().
      if (code === 4009) c.replacedAt = Date.now();
      this.down(c, ws);
    });
    ws.on("error", (e) => {
      if (!c.why) c.why = e.message;
      ws.terminate();
    });
  }

  // End this connection now; `down` then decides when to dial again.
  private drop(c: Conn, why: string, redialNow = false): void {
    if (!c.ws) return;
    c.why = why;
    c.redialNow ||= redialNow;
    c.ws.terminate();
  }

  private down(c: Conn, ws: WebSocket): void {
    if (c.ws !== ws) return;
    c.ws = null;
    const was = c.ready;
    c.ready = false;
    c.pingSentAt = null;
    for (const [id, f] of this.inflight) if (f.url === c.url) this.inflight.delete(id);
    const why = c.why || "connection closed";
    c.why = "";
    if (was) {
      c.downSince = Date.now();
      this.status(c.url, false, why);
      this.emit("relay", c.url, false, why);
      this.edge();
      this.release(c.url);
    }
    this.twins();
    if (this.stopped || c.removed || c.aliasOf) return;
    // Exponential with jitter: between half and all of the current wait.
    const delay = c.redialNow ? 0 : c.backoff * (0.5 + Math.random() / 2);
    c.redialNow = false;
    c.backoff = Math.min(c.backoff * 2, this.o.maxBackoffMs);
    c.timer = setTimeout(() => this.connect(c), delay);
  }

  // Dial now instead of waiting out the backoff.
  private hurry(c: Conn): void {
    c.backoff = this.o.backoffMs;
    if (c.ws || c.removed || c.aliasOf || this.stopped) return;
    if (c.timer) clearTimeout(c.timer);
    this.connect(c);
  }

  // The connection that carries a relay: its own, or the one to the same relay
  // under another name.
  private via(url: string): Conn | undefined {
    const c = this.conns.get(url);
    return c?.aliasOf ? this.conns.get(c.aliasOf) : c;
  }

  // How long a relay has been out of reach. One that is not mine counts as forever.
  private downFor(url: string, now: number): number {
    const c = this.via(url);
    return !c ? Infinity : c.ready ? 0 : now - c.downSince;
  }

  // One relay reached by two names (127.0.0.1 and localhost, or a tunnel's
  // address and the --url it was started with) would take two sockets for one
  // device. The relay keeps one per device and closes the older, so the two
  // would replace each other for as long as the daemon runs. When a connection
  // was just closed that way and another one is logged in to a relay with the
  // same id, the closed one is not dialled again: mail for that name goes
  // through the other. Both conditions are needed. A relay can claim any id,
  // but only the relay this connection went to can close it for a newer login.
  private twins(): void {
    const now = Date.now();
    for (const y of this.conns.values()) {
      if (y.ready || y.aliasOf || !y.relayId || now - y.replacedAt > TWIN_MS) continue;
      const x = [...this.conns.values()].find((x) => x !== y && x.ready && !x.aliasOf && x.relayId === y.relayId);
      if (!x) continue;
      y.aliasOf = x.url;
      if (y.timer) clearTimeout(y.timer);
      y.timer = null;
      this.drop(y, "same relay");
      this.status(y.url, false, `same relay as ${x.url}, which carries its mail`);
      this.emit("twin", y.url, x.url);
    }
  }

  // The connection that stood in for others went down: they dial again.
  private release(url: string): void {
    for (const y of this.conns.values()) {
      if (y.aliasOf !== url) continue;
      y.aliasOf = null;
      y.replacedAt = 0;
      this.hurry(y);
    }
  }

  private edge(): void {
    const now = this.online;
    if (now === this.wasOnline) return;
    this.wasOnline = now;
    this.emit(now ? "ready" : "offline");
  }

  private status(url: string, up: boolean, why: string | null): void {
    try {
      this.node.relayBook.setStatus(url, up, Date.now(), why);
    } catch (e) {
      this.emit("error", e as Error);
    }
  }

  // Returns the bytes written, 0 if the socket was not open.
  private send(ws: WebSocket, frame: ClientFrame): number {
    if (ws.readyState !== ws.OPEN) return 0;
    const text = JSON.stringify(frame);
    ws.send(text);
    return Buffer.byteLength(text);
  }

  // Bytes on their way to this relay that it has not answered for yet.
  // A send past its own deadline no longer counts: it is sent again or gone.
  private unanswered(c: Conn): number {
    const now = Date.now();
    let n = c.ws?.bufferedAmount ?? 0;
    for (const f of this.inflight.values()) if (f.url === c.url && now - f.at < INFLIGHT_MS + slowMs(f.bytes)) n += f.bytes;
    return n;
  }

  private onFrame(c: Conn, ws: WebSocket, frame: ServerFrame): void {
    switch (frame.t) {
      case "challenge": {
        if (!isStr(frame.nonce, 16, 128)) return;
        const d = this.node.device;
        // The address this socket dialled, so the relay can tell the login was meant for it.
        this.send(ws, { t: "auth", credential: d.credential, relay: c.url, sig: sign(d.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(frame.nonce, c.url)) });
        return;
      }
      case "ready":
        if (c.ready) return;
        c.ready = true;
        c.appPing = Array.isArray(frame.features) && frame.features.includes("ping");
        c.relayId = typeof frame.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(frame.id) ? frame.id : null;
        c.backoff = this.o.backoffMs;
        this.status(c.url, true, null);
        this.emit("relay", c.url, true, "");
        this.edge();
        this.twins();
        this.pump();
        return;
      case "pong":
        return;
      case "stored":
        if (!isId(frame.id)) return;
        this.inflight.delete(frame.id);
        this.node.markOutbox(frame.id, "stored");
        return;
      case "error":
        // About a send, it counts only from the relay that send last went to:
        // one relay cannot fail mail that is on its way through another.
        if (isId(frame.id) && this.inflight.get(frame.id)?.url !== c.url) return;
        if (!isId(frame.id)) {
          if (!c.ready) {
            c.why = `refused the login: ${code(frame.code)}`;
            this.status(c.url, false, c.why);
            this.emit("error", new Error(`relay ${c.url} refused the login: ${code(frame.code)}`));
          }
          return;
        }
        this.inflight.delete(frame.id);
        // A full mailbox clears with time; everything else will never succeed.
        if (frame.code !== "mailbox_full") this.node.markOutbox(frame.id, "failed", code(frame.code));
        return;
      case "deliver": {
        const wire = frame.wire as unknown;
        // A relay can send faster than we can decrypt. Past the limit, drop
        // without acknowledging; the relay still holds the message.
        if (this.backlog >= MAX_BACKLOG) return;
        this.backlog++;
        this.chain(async () => {
          this.backlog--;
          try {
            const verdict = await this.node.receive(wire);
            const id = (wire as { header?: { id?: unknown } } | null)?.header?.id;
            if (isId(id)) {
              this.send(ws, { t: "ack", id, ok: verdict.result !== "rejected" });
              this.failures.delete(id);
            }
            this.emit("verdict", verdict);
            if (verdict.result === "applied") for (const e of [verdict.event, ...verdict.promoted]) this.emit("event", e);
          } catch (e) {
            // Our own failure, not the peer's. Leave it unacknowledged and reconnect,
            // which makes the relay deliver it again.
            this.emit("error", e as Error);
            // A message that keeps failing here must not block everything behind
            // it. After three tries it is acknowledged and recorded as refused.
            const id = (wire as { header?: { id?: unknown } } | null)?.header?.id;
            if (isId(id)) {
              const n = (this.failures.get(id) ?? 0) + 1;
              this.failures.set(id, n);
              if (this.failures.size > 1000) this.failures.delete(this.failures.keys().next().value!);
              if (n >= 3) {
                this.failures.delete(id);
                this.node.recordReject("could not be processed after three tries", id);
                this.send(ws, { t: "ack", id, ok: false });
                return;
              }
            }
            if (c.ws === ws) this.drop(c, "local error");
            else ws.terminate();
          }
        });
        return;
      }
    }
  }

  // Deliveries and housekeeping run one at a time. A step that throws, even
  // from its own error handling, must not stop the ones after it.
  private chain(fn: () => Promise<void>): void {
    this.inbound = this.inbound.then(fn).catch((e: unknown) => {
      try {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      } catch {
        // nobody listening for errors
      }
    });
  }

  // ---- liveness

  private tick(): void {
    const now = Date.now();
    const late = now - this.lastTick - this.o.tickMs;
    this.lastTick = now;
    this.sync();
    // Timers stop while the machine sleeps (or the process is stopped) and the
    // wall clock does not. Every connection is suspect; dial again now.
    if (late > this.o.wakeJumpMs) {
      this.emit("wake", late);
      for (const c of this.conns.values()) {
        if (c.ws) this.drop(c, `woke after ${Math.round(late / 1000)}s`, true);
        else this.hurry(c);
      }
      return;
    }
    if (this.o.watchNetwork) {
      const sig = network();
      if (sig !== this.netSig) {
        this.netSig = sig;
        this.emit("network");
        for (const c of this.conns.values()) {
          // A new address may mean the old path is gone. Check it now rather
          // than after the next quiet spell; dial now if it was down.
          if (c.ready && c.pingSentAt === null) this.ping(c, now);
          else if (!c.ws) this.hurry(c);
        }
      }
    }
    for (const c of this.conns.values()) {
      if (!c.ws) continue;
      if (!c.ready) {
        if (now - c.dialledAt > this.o.loginTimeoutMs) this.drop(c, "no login answer");
      } else if (c.pingSentAt !== null) {
        // The pong may be queued behind an upload; see SLOW_BYTES_PER_S.
        if (now - c.pingSentAt > this.o.pingTimeoutMs + slowMs(this.unanswered(c))) this.drop(c, `no answer to a ping in ${Math.round((now - c.pingSentAt) / 1000)}s`);
      } else if (now - c.lastHeard >= this.o.pingEveryMs) this.ping(c, now);
    }
  }

  private ping(c: Conn, now: number): void {
    const ws = c.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    c.pingSentAt = now;
    if (c.appPing) this.send(ws, { t: "ping", n: ++c.pings });
    else ws.ping();
  }

  // ---- receipts, requests, relay lists

  // Queue receipts for what was applied, requests for what is missing and
  // relay lists for contacts who need one. Runs in line with deliveries so it
  // never interleaves with one being decided.
  private tend(): void {
    if (!this.online || this.tending) return;
    this.tending = true;
    this.chain(async () => {
      try {
        if (this.stopped) return;
        await this.node.sendReceipts();
        await this.node.requestMissing();
        await this.node.sendRelayLists();
      } catch (e) {
        this.emit("error", e as Error);
      } finally {
        this.tending = false;
      }
    });
  }

  // ---- sending

  // For each contact device, my relays to send through.
  private routes(now: number): Map<string, Route> {
    if (this.routeCache && now - this.routeCache.at < 1000) return this.routeCache.map;
    const map = new Map<string, Route>();
    const book = this.node.relayBook;
    for (const c of this.node.contacts()) map.set(deviceId(c.credential), book.route(book.their(c.rootKey, c.relay).relays));
    this.routeCache = { at: now, map };
    return map;
  }

  // Send anything queued that is not already awaiting confirmation.
  private pump(): void {
    if (!this.online) return;
    const now = Date.now();
    try {
      const wires = this.node.queued();
      if (!wires.length) return;
      const routes = this.routes(now);
      for (const wire of wires) {
        const id = wire.header.id;
        const f = this.inflight.get(id);
        // A large message on a slow link is still leaving: sending it again
        // would only queue a second copy behind the first.
        if (f && now - f.at < INFLIGHT_MS + slowMs(f.bytes)) continue;
        const route = routes.get(wire.header.to) ?? { preferred: [], fallback: [this.node.relay] };
        // A relay that stops reading must not make us buffer without end.
        const live = (urls: string[]): string[] => [
          ...new Set(
            urls
              .map((u) => this.via(u))
              .filter((c) => !!c?.ready && !!c.ws && c.ws.bufferedAmount < MAX_BUFFERED)
              .map((c) => c!.url),
          ),
        ];
        // A relay the contact reads, in their order. My other relays only when
        // none of theirs has been reachable for a while: a relay that restarts
        // must not send their mail somewhere they never look.
        let order = live(route.preferred);
        if (!order.length && route.preferred.every((u) => this.downFor(u, now) >= this.o.fallbackAfterMs)) order = live(route.fallback);
        if (!order.length) continue;
        // If the last one tried did not answer in time, the next.
        const pick = this.conns.get(order[f ? (order.indexOf(f.url) + 1) % order.length : 0]!)!;
        const bytes = this.send(pick.ws!, { t: "send", wire });
        this.inflight.set(id, { url: pick.url, at: now, bytes });
      }
      if (this.inflight.size > 10_000) for (const [id, f] of this.inflight) if (now - f.at > INFLIGHT_MS + slowMs(f.bytes)) this.inflight.delete(id);
    } catch (e) {
      this.emit("error", e as Error);
    }
  }
}

// The machine's addresses, as one string that changes when the network does.
function network(): string {
  try {
    return Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && !a.internal)
      .map((a) => a!.address)
      .sort()
      .join(",");
  } catch {
    return "";
  }
}
