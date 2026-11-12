import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { type ClientFrame, type ServerFrame, type ThreadEvent, RELAY_AUTH_DOMAIN, isId, isObject, isStr, relayAuthMessage, sign } from "@counterpart/protocol";
import type { Counterpart, Verdict } from "./node.ts";

export interface LinkEvents {
  ready: [];
  offline: [];
  event: [ThreadEvent];
  verdict: [Verdict];
  error: [Error];
}

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

  constructor(node: Counterpart, opts: { pollMs?: number } = {}) {
    super();
    this.node = node;
    this.pollMs = opts.pollMs ?? 250;
  }

  start(): this {
    this.stopped = false;
    this.connect();
    this.poller = setInterval(() => this.pump(), this.pollMs);
    return this;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poller) clearInterval(this.poller);
    this.ws?.terminate();
    this.ws = null;
    this.ready = false;
    await this.inbound;
  }

  get online(): boolean {
    return this.ready;
  }

  private connect(): void {
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
      this.onFrame(ws, frame);
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
        if (!isId(frame.id)) return;
        this.inflight.delete(frame.id);
        // A full mailbox clears with time; everything else will never succeed.
        if (frame.code !== "mailbox_full") this.node.markOutbox(frame.id, "failed", String(frame.code).slice(0, 64));
        return;
      case "deliver": {
        const wire = frame.wire as unknown;
        this.inbound = this.inbound.then(async () => {
          try {
            const verdict = await this.node.receive(wire);
            const id = (wire as { header?: { id?: unknown } } | null)?.header?.id;
            if (isId(id)) this.send(ws, { t: "ack", id });
            this.emit("verdict", verdict);
            if (verdict.result === "applied") for (const e of [verdict.event, ...verdict.promoted]) this.emit("event", e);
          } catch (e) {
            // Our own failure, not the peer's. Leave it unacknowledged so the relay delivers it again.
            this.emit("error", e as Error);
          }
        });
        return;
      }
    }
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
