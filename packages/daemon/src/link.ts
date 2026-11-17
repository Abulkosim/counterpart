import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { type ClientFrame, type PairClientFrame, type PairServerFrame, type ServerFrame, type ThreadEvent, RELAY_AUTH_DOMAIN, isId, isObject, isPairFrame, isStr, relayAuthMessage, sign } from "@counterpart/protocol";
import type { Counterpart, Verdict } from "./node.ts";

const MAX_BACKLOG = 256;

// The relay's error codes are printed and stored. Only plain ones are kept.
const code = (x: unknown): string => (typeof x === "string" && /^[a-z_]{1,32}$/.test(x) ? x : "unknown");

export interface LinkEvents {
  ready: [];
  offline: [];
  event: [ThreadEvent];
  verdict: [Verdict];
  error: [Error];
  // Short-code pairing frames, handled by pairing.ts. Unchecked: the relay wrote them.
  pair: [PairServerFrame];
}

// `event` is a wake-up hint, not a delivery guarantee: a crash between commit
// and emit loses it. Consumers that must not miss events read `node.since(ord)`
// and keep their own cursor.
//
// Keeps one authenticated socket to the relay. Pushes the outbox up, feeds
// deliveries to the node, and acknowledges a delivery only after the node has
// durably decided what to do with it.
export class RelayLink extends EventEmitter<LinkEvents> {
  private node: Counterpart;
  private ws: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private backoff = 250;
  private timer: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private inflight = new Map<string, number>();
  private inbound: Promise<void> = Promise.resolve();
  private pollMs: number;
  private backlog = 0;
  private failures = new Map<string, number>();
  private renewer: NodeJS.Timeout | null = null;
  private tending = false;

  constructor(node: Counterpart, opts: { pollMs?: number } = {}) {
    super();
    this.node = node;
    this.pollMs = opts.pollMs ?? 250;
  }

  start(): this {
    this.stopped = false;
    this.connect();
    this.poller = setInterval(() => {
      this.tend();
      this.pump();
    }, this.pollMs);
    // A long-running daemon must renew its credential too, not only at start.
    this.renewer = setInterval(() => void this.node.renewIfDue().catch((e: Error) => this.emit("error", e)), 3600_000);
    this.renewer.unref();
    return this;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poller) clearInterval(this.poller);
    if (this.renewer) clearInterval(this.renewer);
    this.ws?.terminate();
    this.ws = null;
    this.ready = false;
    await this.inbound;
  }

  get online(): boolean {
    return this.ready;
  }

  // For pairing.ts. False when not logged in; the caller tries again later.
  sendPair(frame: PairClientFrame): boolean {
    const ws = this.ws;
    if (!ws || !this.ready) return false;
    this.send(ws, frame);
    return true;
  }

  private connect(): void {
    // Never log in with a credential that is about to expire.
    void this.node
      .renewIfDue()
      .catch((e: Error) => this.emit("error", e))
      .finally(() => this.dial());
  }

  private dial(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.node.relay, { maxPayload: 1024 * 1024 });
    this.ws = ws;
    ws.on("message", (raw) => {
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
        this.onFrame(ws, frame);
      } catch (e) {
        this.emit("error", e as Error);
        ws.terminate();
      }
    });
    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ready) this.emit("offline");
      this.ready = false;
      this.inflight.clear();
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(), this.backoff * (0.5 + Math.random()));
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    ws.on("close", down);
    ws.on("error", () => ws.terminate());
  }

  private send(ws: WebSocket, frame: ClientFrame): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  private onFrame(ws: WebSocket, frame: ServerFrame): void {
    if (isPairFrame(frame.t)) {
      if (this.ready) this.emit("pair", frame as PairServerFrame);
      return;
    }
    switch (frame.t) {
      case "challenge": {
        if (!isStr(frame.nonce, 16, 128)) return;
        const d = this.node.device;
        this.send(ws, { t: "auth", credential: d.credential, relay: this.node.relay, sig: sign(d.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(frame.nonce, this.node.relay)) });
        return;
      }
      case "ready":
        this.ready = true;
        this.backoff = 250;
        this.emit("ready");
        this.pump();
        return;
      case "stored":
        if (!isId(frame.id)) return;
        this.inflight.delete(frame.id);
        this.node.markOutbox(frame.id, "stored");
        return;
      case "error":
        if (!isId(frame.id)) {
          if (!this.ready) this.emit("error", new Error(`relay refused the login: ${code(frame.code)}`));
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
        this.inbound = this.inbound.then(async () => {
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
            ws.terminate();
          }
        });
        return;
      }
    }
  }

  // Queue receipts for what was applied and requests for what is missing. Runs
  // in line with deliveries so it never interleaves with one being decided.
  private tend(): void {
    if (!this.ready || this.tending) return;
    this.tending = true;
    this.inbound = this.inbound.then(async () => {
      try {
        if (this.stopped) return;
        await this.node.sendReceipts();
        await this.node.requestMissing();
      } catch (e) {
        this.emit("error", e as Error);
      } finally {
        this.tending = false;
      }
    });
  }

  // Send anything queued that is not already awaiting confirmation.
  private pump(): void {
    const ws = this.ws;
    if (!ws || !this.ready) return;
    const now = Date.now();
    try {
      for (const wire of this.node.queued()) {
        const sent = this.inflight.get(wire.header.id);
        if (sent && now - sent < 10_000) continue;
        this.inflight.set(wire.header.id, now);
        this.send(ws, { t: "send", wire });
      }
    } catch (e) {
      this.emit("error", e as Error);
    }
  }
}
