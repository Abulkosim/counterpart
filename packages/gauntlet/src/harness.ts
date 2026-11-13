import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket, { type ServerOptions, WebSocketServer } from "ws";
import { Counterpart, RelayLink, type Verdict } from "@counterpart/daemon";
import {
  hashOf,
  type DeviceCredential, type DeviceSecrets, type EventBodies, type EventType, type KeyPair, type ThreadEvent, type Wire,
  RELAY_AUTH_DOMAIN, SUITE, b64u, canonicalBytes, canonicalize, deviceId, generateSigningKey, hpke, issueDevice, laneOf, parseCanonical,
  randomId, relayAuthMessage, seal, sign, unb64u, utf8,
} from "@counterpart/protocol";
import { type Relay, type RelayOptions, startRelay } from "@counterpart/relay";

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const CLI = join(import.meta.dirname, "../../cli/src/main.ts");
export const REPO = join(import.meta.dirname, "../../..");

const INFO = utf8("counterpart/envelope/v1");
const PLACEHOLDER_RELAY = "ws://127.0.0.1:9";
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export interface Clock {
  now: () => number;
  advance(ms: number): void;
}
export function clock(start = Date.now()): Clock {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

type Sender = Counterpart | DeviceSecrets;
const secretsOf = (x: Sender): DeviceSecrets => (x instanceof Counterpart ? x.device : x);
const credentialOf = (x: Counterpart | Pick<DeviceCredential, "signKey" | "encKey">): Pick<DeviceCredential, "signKey" | "encKey"> =>
  x instanceof Counterpart ? x.device.credential : x;

// An event as `from` would write it. `over` replaces or adds fields, valid or not.
export function event<T extends EventType>(from: Sender, threadId: string, type: T, body: EventBodies[T], authorSeq = 0, parents: string[] = [], over: Record<string, unknown> = {}): ThreadEvent {
  return { id: randomId(), threadId, author: deviceId(secretsOf(from).credential), authorSeq, parents, lane: laneOf(type), type, body, createdAt: Date.now(), ...over } as ThreadEvent;
}

// The honest path: a well-formed event sealed by its real author.
export function send(from: Sender, to: Counterpart | Pick<DeviceCredential, "signKey" | "encKey">, e: ThreadEvent, expiresAt = Date.now() + HOUR): Promise<Wire> {
  return seal(e, secretsOf(from), credentialOf(to), expiresAt);
}

export async function rawSeal(plaintext: Uint8Array, encKey: string, aad: Uint8Array): Promise<{ enc: string; ct: string }> {
  const recipientPublicKey = await hpke.kem.deserializePublicKey(buf(unb64u(encKey)));
  const { enc, ct } = await hpke.seal({ recipientPublicKey, info: buf(INFO) }, buf(plaintext), buf(aad));
  return { enc: b64u(enc), ct: b64u(ct) };
}

// Decrypt without checking anything, the way a recipient who wants to reuse the contents would.
export async function peel(wire: Wire, me: Sender): Promise<{ event: ThreadEvent; sig: string; credential: DeviceCredential }> {
  const recipientKey = await hpke.kem.deserializePrivateKey(buf(unb64u(secretsOf(me).enc.secretKey)));
  const pt = await hpke.open({ recipientKey, enc: buf(unb64u(wire.enc)), info: buf(INFO) }, buf(unb64u(wire.ct)), buf(canonicalBytes(wire.header)));
  return parseCanonical(new Uint8Array(pt)) as never;
}

// Everything `seal` decides for an honest sender, opened up so a case can get each part wrong on purpose.
export interface Forgery {
  from: Sender;
  to: Counterpart | Pick<DeviceCredential, "signKey" | "encKey">;
  event: unknown;
  expiresAt?: number;
  header?: Record<string, unknown>; // replaces fields of the header that is sent, bound and signed
  signed?: unknown; // what the signature covers, instead of { header, event }
  signer?: KeyPair;
  domain?: string;
  sig?: unknown;
  credential?: unknown;
  signedCredential?: unknown; // the credential the signature was made over, when it differs from the one sent
  inner?: (inner: Record<string, unknown>) => unknown;
  plaintext?: (canonical: string) => string | Uint8Array;
  bound?: unknown; // header used as associated data, instead of the one sent
}

// The signature covers a hash of the credential. A forged credential that
// cannot even be hashed gets a placeholder; such a message fails earlier anyway.
function credentialHash(c: unknown): string {
  try {
    return hashOf(c);
  } catch {
    return "unhashable";
  }
}

export async function forge(f: Forgery): Promise<Wire> {
  const from = secretsOf(f.from);
  const to = credentialOf(f.to);
  const header = { v: 1, suite: SUITE, id: (f.event as { id?: unknown } | null)?.id, to: deviceId(to), expiresAt: f.expiresAt ?? Date.now() + HOUR, ...f.header };
  const sig = f.sig ?? sign(f.signer ?? from.sign, f.domain ?? "event/v1", canonicalBytes(f.signed ?? { header, event: f.event, credential: credentialHash(f.signedCredential ?? f.credential ?? from.credential) }));
  const base = { event: f.event, sig, credential: f.credential ?? from.credential };
  const inner = f.inner ? f.inner(base) : base;
  const text = f.plaintext ? f.plaintext(canonicalize(inner)) : canonicalize(inner);
  const sealed = await rawSeal(typeof text === "string" ? utf8(text) : text, to.encKey, canonicalBytes(f.bound ?? header));
  return { header, ...sealed } as Wire;
}

export function mint(root: KeyPair, fields: Record<string, unknown> & { signKey: string; encKey: string }, signer: KeyPair = root): DeviceCredential {
  const body = { v: 1, rootKey: root.publicKey, issuedAt: Date.now(), expiresAt: Date.now() + 90 * DAY, ...fields };
  return { ...body, sig: sign(signer, "device-credential/v1", canonicalBytes(body)) } as DeviceCredential;
}

export interface Identity {
  root: KeyPair;
  device: DeviceSecrets;
}
export async function identity(now = Date.now()): Promise<Identity> {
  const root = generateSigningKey();
  return { root, device: await issueDevice(root, now) };
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Another base64url string that decodes to the same bytes, or null if there is none.
export function respell(s: string): string | null {
  const spare = s.length % 4 === 2 ? 4 : s.length % 4 === 3 ? 2 : 0;
  if (!spare) return null;
  const last = ALPHABET.indexOf(s.at(-1)!);
  return s.slice(0, -1) + ALPHABET[last ^ ((1 << spare) - 1)];
}
export function flipByte(s: string, at = 0): string {
  const b = unb64u(s);
  b[at < 0 ? b.length + at : at]! ^= 1;
  return b64u(b);
}

export interface Frame {
  t: string;
  id?: string;
  code?: string;
  nonce?: string;
  device?: string;
  wire?: Wire;
}

export interface Client {
  ws: WebSocket;
  send(frame: unknown): void;
  next(t?: string, ms?: number): Promise<Frame>;
  seen(t: string): Frame[];
  closed: Promise<number>;
  isOpen(): boolean;
}

export interface EvilConn {
  ws: WebSocket;
  frames: Record<string, unknown>[];
  send(frame: unknown): void; // strings and buffers go out as they are
  wait(t: string, ms?: number): Promise<Record<string, unknown>>;
  count(t: string): number;
  isOpen(): boolean;
}
export interface EvilRelay {
  url: string;
  conns: EvilConn[];
  conn(index?: number, ms?: number): Promise<EvilConn>;
}

export interface Child {
  proc: ChildProcess;
  stdout(): Buffer;
  stderr(): Buffer;
}

export interface Counts {
  events: number;
  held: number;
  rejects: number;
}

export async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
export const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// One per case. Everything it hands out is torn down by `close`.
export class Ctx {
  private cleanup: (() => unknown)[] = [];

  // With a passphrase the person can approve contracts. The key derivation is kept cheap: these are tests.
  async person(opts: { relay?: string; now?: () => number; passphrase?: string } = {}): Promise<Counterpart> {
    const home = this.dir();
    const node = await Counterpart.init(home, { relay: opts.relay ?? PLACEHOLDER_RELAY, ...(opts.now ? { now: opts.now } : {}), ...(opts.passphrase ? { passphrase: opts.passphrase, logN: 14 } : {}) });
    this.cleanup.push(() => {
      try {
        node.close();
      } catch {
        // already closed by the case
      }
    });
    return node;
  }

  dir(): string {
    const d = mkdtempSync(join(tmpdir(), "cpart-gauntlet-"));
    this.cleanup.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  }

  // The root and device secrets a person holds on disk.
  secrets(node: Counterpart): Identity {
    return JSON.parse(readFileSync(join(node.home, "keys.json"), "utf8")) as Identity;
  }

  // Hand every queued message for `to` straight to it, with no relay in between.
  async carry(from: Counterpart, to: Counterpart): Promise<Verdict[]> {
    const verdicts: Verdict[] = [];
    for (const wire of from.queued()) {
      if (wire.header.to !== to.me.device) continue;
      verdicts.push(await to.receive(wire));
      from.markOutbox(wire.header.id, "stored");
    }
    return verdicts;
  }

  // A new person who is an accepted contact of `of`, filed there under `name`.
  async contact(of: Counterpart, name: string, opts: { now?: () => number; passphrase?: string } = {}): Promise<Counterpart> {
    const p = await this.person({ relay: of.relay, ...opts });
    await p.acceptInvite(of.createInvite(name), "them");
    await this.carry(p, of);
    await this.carry(of, p);
    assert.equal(of.contact(name).state, "active");
    assert.equal(p.contact("them").state, "active");
    return p;
  }

  // `opener` starts a thread with the contact it calls `name`, and the other side learns of it.
  async thread(opener: Counterpart, name: string, other: Counterpart, goal = "agree on something"): Promise<string> {
    const id = await opener.openThread(name, goal);
    await this.carry(opener, other);
    assert.ok(other.threads().some((t) => t.id === id));
    return id;
  }

  texts(node: Counterpart, thread: string): string[] {
    return node.log(thread).filter((e) => e.type === "talk.posted" && e.status === "applied").map((e) => (e.body as { text: string }).text);
  }

  counts(node: Counterpart): Counts {
    const db = new DatabaseSync(join(node.home, "state.db"), { readOnly: true });
    try {
      const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
      return {
        events: n("SELECT COUNT(*) AS n FROM events"),
        held: n("SELECT COUNT(*) AS n FROM events WHERE status = 'pending'"),
        rejects: n("SELECT COUNT(*) AS n FROM rejects"),
      };
    } finally {
      db.close();
    }
  }

  // Everything a peer could hope to change, as one comparable string.
  snapshot(node: Counterpart): string {
    const { events, held } = this.counts(node);
    return JSON.stringify({ contacts: node.contacts(), threads: node.threads(), applied: node.since(0, 1_000_000), events, held, outbox: node.queued().map((w) => w.header.id) });
  }

  // The message must be refused, recorded, and leave no other trace.
  async refused(node: Counterpart, wire: unknown, what = "the message"): Promise<void> {
    const before = this.snapshot(node);
    const v = await node.receive(wire);
    if (v.result !== "rejected") assert.fail(`${what}: expected a refusal, got ${v.result}`);
    // Cases do not assert on reasons. Set this to read them and check each refusal is the intended one.
    if (process.env.GAUNTLET_TRACE) console.log(`         ${what}: ${v.reason}`);
    assert.equal(this.snapshot(node), before, `${what}: refused, but state changed`);
    assert.equal(node.rejects(1)[0]?.reason, v.reason, `${what}: refused without a record`);
  }

  async relay(opts: RelayOptions = {}): Promise<Relay> {
    const relay = await startRelay(opts);
    this.cleanup.push(() => relay.close());
    return relay;
  }

  async online(relay: Relay): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
    return ((await res.json()) as { online: number }).online;
  }

  connect(node: Counterpart): RelayLink {
    const link = new RelayLink(node, { pollMs: 15 });
    link.on("error", () => {});
    this.cleanup.push(() => link.stop());
    return link.start();
  }

  dial(url: string, opts: WebSocket.ClientOptions = {}): Client {
    const ws = new WebSocket(url, opts);
    this.cleanup.push(() => ws.terminate());
    const frames: Frame[] = [];
    const all: Frame[] = [];
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString()) as Frame;
      frames.push(f);
      all.push(f);
    });
    ws.on("error", () => {});
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    const opened = new Promise<void>((r) => {
      ws.on("open", () => r());
      ws.on("close", () => r());
    });
    return {
      ws,
      closed,
      isOpen: () => ws.readyState === ws.OPEN,
      seen: (t) => all.filter((f) => f.t === t),
      send(frame) {
        void opened.then(() => {
          if (ws.readyState === ws.OPEN) ws.send(typeof frame === "string" || Buffer.isBuffer(frame) ? frame : JSON.stringify(frame));
        });
      },
      async next(t, ms = 3000) {
        let found: Frame | undefined;
        await until(`a ${t ?? "frame"} from the relay`, () => {
          const i = frames.findIndex((f) => !t || f.t === t);
          if (i >= 0) found = frames.splice(i, 1)[0];
          return i >= 0;
        }, ms);
        return found!;
      },
    };
  }

  async login(d: Sender, url: string): Promise<Client> {
    const device = secretsOf(d);
    const c = this.dial(url);
    const { nonce } = await c.next("challenge");
    c.send({ t: "auth", credential: device.credential, relay: url, sig: sign(device.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(nonce!, url)) });
    await c.next("ready");
    return c;
  }

  // A relay that does only what the case tells it to.
  async evilRelay(onConn: (c: EvilConn) => void = () => {}, opts: ServerOptions = {}): Promise<EvilRelay> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 8 * 1024 * 1024, ...opts });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const conns: EvilConn[] = [];
    wss.on("connection", (ws) => {
      const frames: Record<string, unknown>[] = [];
      ws.on("error", () => {});
      ws.on("message", (raw) => {
        try {
          frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        } catch {
          frames.push({ t: "unparsed" });
        }
      });
      const c: EvilConn = {
        ws,
        frames,
        isOpen: () => ws.readyState === ws.OPEN,
        count: (t) => frames.filter((f) => f.t === t).length,
        send(frame) {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(typeof frame === "string" || Buffer.isBuffer(frame) ? frame : JSON.stringify(frame));
        },
        async wait(t, ms = 3000) {
          let found: Record<string, unknown> | undefined;
          await until(`a ${t} frame from the daemon`, () => !!(found = frames.find((f) => f.t === t)), ms);
          frames.splice(frames.indexOf(found!), 1);
          return found!;
        },
      };
      conns.push(c);
      onConn(c);
    });
    this.cleanup.push(async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    });
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    return {
      url,
      conns,
      async conn(index = 0, ms = 4000) {
        await until(`connection ${index} to the hostile relay`, () => conns.length > index, ms);
        return conns[index]!;
      },
    };
  }

  // Run the real CLI to completion and return exactly the bytes it printed.
  cli(home: string, args: string[], opts: { umask?: string } = {}): { stdout: Buffer; stderr: Buffer; status: number | null } {
    const env = { ...process.env, CPART_HOME: home };
    const r = opts.umask
      ? spawnSync("sh", ["-c", `umask ${opts.umask}; exec "$0" "$@"`, process.execPath, CLI, ...args], { env, timeout: 20_000 })
      : spawnSync(process.execPath, [CLI, ...args], { env, timeout: 20_000 });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  }

  // Start the real CLI and leave it running.
  spawnCli(home: string, args: string[]): Child {
    const proc = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, CPART_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => err.push(d));
    this.cleanup.push(
      () =>
        new Promise<void>((r) => {
          if (proc.exitCode !== null || proc.signalCode !== null) return r();
          proc.once("exit", () => r());
          proc.kill("SIGKILL");
        }),
    );
    return { proc, stdout: () => Buffer.concat(out), stderr: () => Buffer.concat(err) };
  }

  async close(): Promise<void> {
    for (const fn of this.cleanup.reverse()) {
      try {
        await fn();
      } catch {
        // teardown is best effort
      }
    }
    this.cleanup = [];
  }
}

// The usual scene: Bob is the one under attack. Alice is an honest contact with a thread open.
export async function scene(ctx: Ctx, opts: { now?: () => number } = {}): Promise<{ bob: Counterpart; alice: Counterpart; thread: string }> {
  const bob = await ctx.person(opts);
  const alice = await ctx.contact(bob, "alice", opts);
  const thread = await ctx.thread(alice, "them", bob, "alice and bob only");
  return { bob, alice, thread };
}
