import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type ClientFrame, type PairClientFrame, type ServerFrame, LIMITS, RELAY_AUTH_DOMAIN, canonicalize, deviceId, isId, isObject, isStr,
  isPairFrame, parseWire, relayAuthMessage, verify, verifyCredential,
} from "@counterpart/protocol";
import { type NameplateOptions, type PairOrigin, nameplates } from "./nameplates.ts";
import { type RelayNames, relayId, relayNames } from "./names.ts";

export { relayNames, splitUrls } from "./names.ts";

export interface RelayOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  // The URL clients dial. A login is only valid for exactly this URL, which stops
  // another relay forwarding our challenge to its own clients. Defaults to
  // ws://host:port.
  publicUrl?: string;
  // More addresses this relay answers to, after publicUrl. See names.ts for
  // what it answers to when neither is given.
  urls?: string[];
  // Root keys allowed to use this relay. Empty means open.
  allowRoots?: string[];
  maxPerSender?: number; // queued messages from one device to one device
  maxPerMailbox?: number;
  maxPerSenderTotal?: number; // queued messages from one device to everyone
  maxTotal?: number;
  deliveryWindow?: number; // unacknowledged deliveries per connection
  // A sender is "known" to a recipient once the recipient has accepted a
  // message from it. Everyone else shares a small allowance per mailbox, so
  // throwaway identities cannot fill a mailbox and lock out real contacts.
  maxUnknownPerMailbox?: number;
  maxPerUnknownSender?: number;
  maxUnauthenticated?: number; // sockets that have not logged in yet
  framesPerSecond?: number;
  now?: () => number;
  log?: (line: string) => void;
  // Short-code pairing mailboxes (nameplates.ts). Limits for tests.
  pairing?: Omit<NameplateOptions, "deliver" | "now" | "log">;
}

export interface Relay {
  url: string;
  urls: string[]; // every address it answers to, url first
  id: string; // see relayId in names.ts
  port: number;
  queued(device?: string): number;
  // Re-send everything queued for a connected device. Delivery is at least once,
  // so recipients must already cope with this.
  redeliver(device: string): number;
  close(): Promise<void>;
}

interface Session {
  device: string | null;
  outstanding: Set<string>;
  nonce: string;
  tokens: number;
  refilled: number;
  pair: PairOrigin; // who this is, for the nameplate limits
}

export async function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const maxPerSender = opts.maxPerSender ?? 500;
  const maxPerMailbox = opts.maxPerMailbox ?? 5000;
  const maxPerSenderTotal = opts.maxPerSenderTotal ?? 2000;
  const maxTotal = opts.maxTotal ?? 200_000;
  const window = opts.deliveryWindow ?? 100;
  const maxUnknownPerMailbox = opts.maxUnknownPerMailbox ?? 50;
  const maxPerUnknownSender = opts.maxPerUnknownSender ?? 5;
  const maxUnauthenticated = opts.maxUnauthenticated ?? 128;
  let unauthenticated = 0;
  // Rate limits follow the device, not the socket, so reconnecting earns nothing.
  const buckets = new Map<string, { tokens: number; refilled: number }>();
  const rate = opts.framesPerSecond ?? 50;
  const allow = new Set(opts.allowRoots ?? []);
  const given = [...(opts.publicUrl ? [opts.publicUrl] : []), ...(opts.urls ?? [])];
  // A bad address is refused before anything listens.
  if (given.length) relayNames("", 0, given);

  const db = new DatabaseSync(opts.dbPath ?? ":memory:");
  db.exec(`
    PRAGMA busy_timeout = 5000;
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
    CREATE INDEX IF NOT EXISTS mailbox_from ON mailbox (from_device);
    CREATE TABLE IF NOT EXISTS known (to_device TEXT NOT NULL, from_device TEXT NOT NULL, PRIMARY KEY (to_device, from_device));
  `);
  const q = {
    find: db.prepare("SELECT hash, from_device FROM mailbox WHERE to_device = ? AND id = ?"),
    insert: db.prepare("INSERT INTO mailbox (to_device, id, from_device, hash, wire, expires_at) VALUES (?, ?, ?, ?, ?, ?)"),
    pending: db.prepare("SELECT id, wire FROM mailbox WHERE to_device = ? AND expires_at > ? ORDER BY seq LIMIT ?"),
    countFrom: db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE from_device = ?"),
    ack: db.prepare("DELETE FROM mailbox WHERE to_device = ? AND id = ?"),
    sender: db.prepare("SELECT from_device FROM mailbox WHERE to_device = ? AND id = ?"),
    know: db.prepare("INSERT OR IGNORE INTO known (to_device, from_device) VALUES (?, ?)"),
    isKnown: db.prepare("SELECT 1 FROM known WHERE to_device = ? AND from_device = ?"),
    countUnknown: db.prepare("SELECT COUNT(*) AS n FROM mailbox m WHERE m.to_device = ? AND NOT EXISTS (SELECT 1 FROM known k WHERE k.to_device = m.to_device AND k.from_device = m.from_device)"),
    countPair: db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE to_device = ? AND from_device = ?"),
    countBox: db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE to_device = ?"),
    countAll: db.prepare("SELECT COUNT(*) AS n FROM mailbox"),
    sweep: db.prepare("DELETE FROM mailbox WHERE expires_at <= ?"),
  };
  const count = (stmt: typeof q.countAll, ...args: string[]): number => (stmt.get(...args) as { n: number }).n;
  const id = relayId(db);

  const online = new Map<string, { ws: WebSocket; s: Session }>();
  let names: RelayNames | undefined;
  const http = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, id, online: online.size, queued: count(q.countAll) }));
    } else res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: LIMITS.wireBytes * 2 });

  const send = (ws: WebSocket, frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const plates = nameplates({ ...opts.pairing, now, log, deliver: (device, frame) => { const c = online.get(device); if (c) send(c.ws, frame); } });
  // Send the oldest queued messages, at most one window at a time. The next
  // window goes out when the client has acknowledged the current one.
  const flush = (device: string): number => {
    const c = online.get(device);
    if (!c) return 0;
    const rows = q.pending.all(device, now(), window) as { id: string; wire: string }[];
    c.s.outstanding = new Set(rows.map((r) => r.id));
    for (const r of rows) send(c.ws, { t: "deliver", wire: JSON.parse(r.wire) });
    return rows.length;
  };
  const refuse = (ws: WebSocket, code: string): void => {
    send(ws, { t: "error", code });
    ws.close(4003, "auth failed");
  };

  wss.on("connection", (ws, req) => {
    const s: Session = { device: null, outstanding: new Set(), nonce: randomBytes(24).toString("base64url"), tokens: rate * 2, refilled: now(), pair: { addr: req.socket.remoteAddress } };
    if (unauthenticated >= maxUnauthenticated) return ws.close(4013, "too many connections waiting to log in");
    unauthenticated++;
    let counted = true;
    const uncount = (): void => {
      if (counted) unauthenticated--;
      counted = false;
    };
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
          if (!names?.has(frame.relay)) throw new RelayError("wrong_relay_url");
          if (!verify(cred.signKey, RELAY_AUTH_DOMAIN, relayAuthMessage(s.nonce, frame.relay), frame.sig)) throw new Error("signature");
          if (allow.size > 0 && !allow.has(cred.rootKey)) throw new RelayError("not_invited");
          s.device = deviceId(cred);
          s.pair.root = cred.rootKey;
        } catch (e) {
          log(`auth rejected: ${(e as Error).message}`);
          return refuse(ws, e instanceof RelayError ? e.code : "auth_failed");
        }
        clearTimeout(authTimer);
        uncount();
        const kept = buckets.get(s.device);
        if (kept) {
          s.tokens = Math.min(s.tokens, kept.tokens + ((t - kept.refilled) / 1000) * rate);
          if (s.tokens < 0) return ws.close(4008, "rate limit");
        }
        online.get(s.device)?.ws.close(4009, "replaced by a newer connection");
        online.set(s.device, { ws, s });
        send(ws, { t: "ready", device: s.device, features: ["ping"], id });
        flush(s.device);
        plates.online(s.device);
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
            const stranger = !q.isKnown.get(to, s.device);
            if (stranger && (count(q.countPair, to, s.device) >= maxPerUnknownSender || count(q.countUnknown, to) >= maxUnknownPerMailbox)) throw new RelayError("mailbox_full");
            if (
              count(q.countPair, to, s.device) >= maxPerSender ||
              count(q.countBox, to) >= maxPerMailbox ||
              count(q.countFrom, s.device) >= maxPerSenderTotal ||
              count(q.countAll) >= maxTotal
            )
              throw new RelayError("mailbox_full");
            q.insert.run(to, id, s.device, hash, text, wire.header.expiresAt);
          }
          send(ws, { t: "stored", id });
          const peer = online.get(to);
          if (peer && peer.s.outstanding.size < window) {
            peer.s.outstanding.add(id);
            send(peer.ws, { t: "deliver", wire });
          }
        } catch (e) {
          send(ws, { t: "error", code: e instanceof RelayError ? e.code : "bad_wire", ...(id ? { id } : {}) });
        }
      } else if (frame.t === "ack") {
        if (!isId(frame.id)) return;
        // `ok` means the recipient accepted the message, which makes its sender known to them.
        if ((frame as { ok?: unknown }).ok === true) {
          const from = (q.sender.get(s.device, frame.id) as { from_device: string } | undefined)?.from_device;
          if (from) q.know.run(s.device, from);
        }
        q.ack.run(s.device, frame.id);
        if (s.outstanding.delete(frame.id) && s.outstanding.size === 0) flush(s.device);
      } else if (frame.t === "ping") {
        // Lets a client notice within seconds that the path to us is dead.
        const n = (frame as { n?: unknown }).n;
        send(ws, { t: "pong", n: Number.isSafeInteger(n) ? (n as number) : 0 });
      } else if (isPairFrame(frame.t)) plates.handle(s.device, frame as PairClientFrame, s.pair);
      else ws.close(4002, "bad frame");
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      uncount();
      if (s.device) {
        buckets.set(s.device, { tokens: s.tokens, refilled: s.refilled });
        if (buckets.size > 50_000) buckets.delete(buckets.keys().next().value!);
      }
      if (s.device && online.get(s.device)?.ws === ws) online.delete(s.device);
    });
    ws.on("error", () => ws.terminate());
  });

  const sweeper = setInterval(() => q.sweep.run(now()), 60_000);
  sweeper.unref();

  // ws re-emits the HTTP server's errors. Without a listener, a port already in
  // use would crash the process with an uncaught exception.
  wss.on("error", (e) => log(`server error: ${e.message}`));
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    clearInterval(sweeper);
    plates.close();
    db.close();
    const err = e as NodeJS.ErrnoException;
    throw err.code === "EADDRINUSE" ? new Error(`port ${opts.port} on ${opts.host ?? "127.0.0.1"} is already in use. Stop what is using it or pick another with --port`) : err;
  }
  const port = (http.address() as AddressInfo).port;
  names = relayNames(opts.host ?? "127.0.0.1", port, given);
  const url = names.primary;
  log(`relay listening on ${url}${names.all.length > 1 ? ` (also answers to ${names.all.slice(1).join(", ")})` : ""}`);

  return {
    url,
    urls: names.all,
    id,
    port,
    queued: (device) => (device ? count(q.countBox, device) : count(q.countAll)),
    redeliver: flush,
    async close() {
      clearInterval(sweeper);
      plates.close();
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
