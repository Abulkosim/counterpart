import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type ClientFrame, type ServerFrame, LIMITS, RELAY_AUTH_DOMAIN, canonicalize, deviceId, isId, isObject, isStr,
  parseWire, relayAuthMessage, verify, verifyCredential,
} from "@counterpart/protocol";

export interface RelayOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  // If set, clients must have dialled exactly this URL.
  publicUrl?: string;
  // Root keys allowed to use this relay. Empty means open.
  allowRoots?: string[];
  maxPerSender?: number; // queued messages from one device to one device
  maxPerMailbox?: number;
  framesPerSecond?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Relay {
  url: string;
  port: number;
  queued(device?: string): number;
  // Re-send everything queued for a connected device. Delivery is at least once,
  // so recipients must already cope with this.
  redeliver(device: string): number;
  close(): Promise<void>;
}

interface Session {
  device: string | null;
  nonce: string;
  tokens: number;
  refilled: number;
}

export async function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const maxPerSender = opts.maxPerSender ?? 500;
  const maxPerMailbox = opts.maxPerMailbox ?? 5000;
  const rate = opts.framesPerSecond ?? 50;
  const allow = new Set(opts.allowRoots ?? []);

  const db = new DatabaseSync(opts.dbPath ?? ":memory:");
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS mailbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      to_device TEXT NOT NULL,
      id TEXT NOT NULL,
      from_device TEXT NOT NULL,
      hash TEXT NOT NULL,
      wire TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE (to_device, id)
    );
    CREATE INDEX IF NOT EXISTS mailbox_pair ON mailbox (to_device, from_device);
  `);
  const q = {
    find: db.prepare("SELECT hash, from_device FROM mailbox WHERE to_device = ? AND id = ?"),
    insert: db.prepare("INSERT INTO mailbox (to_device, id, from_device, hash, wire, expires_at) VALUES (?, ?, ?, ?, ?, ?)"),
    pending: db.prepare("SELECT wire FROM mailbox WHERE to_device = ? AND expires_at > ? ORDER BY seq"),
    ack: db.prepare("DELETE FROM mailbox WHERE to_device = ? AND id = ?"),
    countPair: db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE to_device = ? AND from_device = ?"),
    countBox: db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE to_device = ?"),
    countAll: db.prepare("SELECT COUNT(*) AS n FROM mailbox"),
    sweep: db.prepare("DELETE FROM mailbox WHERE expires_at <= ?"),
  };
  const count = (stmt: typeof q.countAll, ...args: string[]): number => (stmt.get(...args) as { n: number }).n;

  const online = new Map<string, WebSocket>();
  const http = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, online: online.size, queued: count(q.countAll) }));
    } else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: LIMITS.wireBytes * 2 });

  const send = (ws: WebSocket, frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const flush = (device: string): number => {
    const ws = online.get(device);
    if (!ws) return 0;
    const rows = q.pending.all(device, now()) as { wire: string }[];
    for (const r of rows) send(ws, { t: "deliver", wire: JSON.parse(r.wire) });
    return rows.length;
  };

  wss.on("connection", (ws) => {
    const s: Session = { device: null, nonce: randomBytes(24).toString("base64url"), tokens: rate * 2, refilled: now() };
    const authTimer = setTimeout(() => ws.close(4001, "auth timeout"), 10_000);
    send(ws, { t: "challenge", nonce: s.nonce });

    ws.on("message", (raw, isBinary) => {
      const t = now();
      s.tokens = Math.min(rate * 2, s.tokens + ((t - s.refilled) / 1000) * rate);
      s.refilled = t;
      if (--s.tokens < 0) return ws.close(4008, "rate limit");
      let frame: ClientFrame;
      try {
        if (isBinary) throw new Error("binary");
        const x: unknown = JSON.parse(raw.toString());
        if (!isObject(x) || !isStr(x.t)) throw new Error("shape");
        frame = x as ClientFrame;
      } catch {
        return ws.close(4002, "bad frame");
      }

      if (s.device === null) {
        if (frame.t !== "auth") return ws.close(4003, "auth required");
        try {
          const cred = verifyCredential(frame.credential, t);
          if (!isStr(frame.relay, 1, 512) || !isStr(frame.sig)) throw new Error("fields");
          if (opts.publicUrl && frame.relay !== opts.publicUrl) throw new Error("wrong relay url");
          if (!verify(cred.signKey, RELAY_AUTH_DOMAIN, relayAuthMessage(s.nonce, frame.relay), frame.sig)) throw new Error("signature");
          if (allow.size > 0 && !allow.has(cred.rootKey)) throw new Error("not invited");
          s.device = deviceId(cred);
        } catch (e) {
          log(`auth rejected: ${(e as Error).message}`);
          return ws.close(4003, "auth failed");
        }
        clearTimeout(authTimer);
        online.get(s.device)?.close(4009, "replaced by a newer connection");
        online.set(s.device, ws);
        send(ws, { t: "ready", device: s.device });
        flush(s.device);
        return;
      }

      if (frame.t === "send") {
        let id: string | undefined;
        try {
          const wire = parseWire(frame.wire);
          id = wire.header.id;
          const text = canonicalize(wire);
          if (Buffer.byteLength(text) > LIMITS.wireBytes) throw new RelayError("too_large");
          if (wire.header.expiresAt <= t) throw new RelayError("expired");
          if (wire.header.expiresAt > t + LIMITS.maxTtlMs) throw new RelayError("ttl_too_long");
          const hash = createHash("sha256").update(text).digest("base64url");
          const to = wire.header.to;
          const existing = q.find.get(to, id) as { hash: string; from_device: string } | undefined;
          if (existing) {
            // Retrying the same message is fine. Reusing an id for different bytes is not.
            if (existing.hash !== hash || existing.from_device !== s.device) throw new RelayError("conflict");
          } else {
            if (count(q.countPair, to, s.device) >= maxPerSender || count(q.countBox, to) >= maxPerMailbox) throw new RelayError("mailbox_full");
            q.insert.run(to, id, s.device, hash, text, wire.header.expiresAt);
          }
          send(ws, { t: "stored", id });
          const peer = online.get(to);
          if (peer) send(peer, { t: "deliver", wire });
        } catch (e) {
          send(ws, { t: "error", code: e instanceof RelayError ? e.code : "bad_wire", ...(id ? { id } : {}) });
        }
      } else if (frame.t === "ack") {
        if (isId(frame.id)) q.ack.run(s.device, frame.id);
      } else ws.close(4002, "bad frame");
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (s.device && online.get(s.device) === ws) online.delete(s.device);
    });
    ws.on("error", () => ws.terminate());
  });

  const sweeper = setInterval(() => q.sweep.run(now()), 60_000);
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve);
  });
  const port = (http.address() as AddressInfo).port;
  const url = opts.publicUrl ?? `ws://${opts.host ?? "127.0.0.1"}:${port}`;
  log(`relay listening on ${url}`);

  return {
    url,
    port,
    queued: (device) => (device ? count(q.countBox, device) : count(q.countAll)),
    redeliver: flush,
    async close() {
      clearInterval(sweeper);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
      db.close();
    },
  };
}

class RelayError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
