import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { type Relay, startRelay } from "@counterpart/relay";
import { Counterpart, type LinkOptions, RelayLink } from "../src/index.ts";
import { type Proxy, startProxy } from "../../../scripts/tcp-proxy.ts";

const dirs: string[] = [];
const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const f of cleanup.reverse()) await Promise.resolve(f()).catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Fast clocks so each test takes seconds. The defaults are in link.ts.
const FAST: LinkOptions = { pollMs: 20, tickMs: 50, pingEveryMs: 300, pingTimeoutMs: 300, loginTimeoutMs: 1000, backoffMs: 50, maxBackoffMs: 400, wakeJumpMs: 700, watchNetwork: false };

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "cpart-link-"));
  dirs.push(d);
  return d;
}
async function person(url: string): Promise<Counterpart> {
  return Counterpart.init(dir(), { relay: url });
}
function connect(node: Counterpart, opts: LinkOptions = {}): RelayLink {
  const link = new RelayLink(node, { ...FAST, ...opts });
  link.on("error", () => {});
  cleanup.push(() => link.stop());
  return link.start();
}
async function until(what: string, cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const texts = (n: Counterpart, thread: string): string[] =>
  n.log(thread).filter((e) => e.type === "talk.posted" && e.status === "applied").map((e) => (e.body as { text: string }).text);

// Alice reaches the relay through a proxy that can black-hole; Bob through one that never does.
async function scene(opts: { relay?: Parameters<typeof startRelay>[0] } = {}): Promise<{ relay: Relay; pa: Proxy; alice: Counterpart; bob: Counterpart; la: RelayLink; lb: RelayLink; thread: string }> {
  let port = 0;
  const pa = await startProxy({ targetPort: () => port });
  const pb = await startProxy({ targetPort: () => port });
  const urlA = `ws://127.0.0.1:${pa.port}`;
  const urlB = `ws://127.0.0.1:${pb.port}`;
  const relay = await startRelay({ urls: [urlA, urlB], ...opts.relay });
  port = relay.port;
  cleanup.push(() => relay.close(), () => pa.close(), () => pb.close());
  const alice = await person(urlA);
  const bob = await person(urlB);
  // Bob's name for the relay differs from Alice's. He tells his node both are the same.
  bob.relayBook.add(urlB, urlA, Date.now(), { announce: false });
  const la = connect(alice);
  const lb = connect(bob);
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await until("pairing", () => bob.contact("alice").state === "active" && alice.contact("bob").state === "active");
  const thread = await alice.openThread("bob", "resilience");
  await until("bob has the thread", () => bob.threads().length === 1);
  return { relay, pa, alice, bob, la, lb, thread };
}

test("a black-holed connection is noticed within seconds, and nothing queued is lost", async () => {
  const { pa, alice, bob, la, thread } = await scene();
  const downs: { at: number; why: string }[] = [];
  la.on("relay", (_u, up, why) => void (up || downs.push({ at: Date.now(), why })));
  await until("alice is connected", () => la.online);

  const cut = Date.now();
  pa.blackhole(true);
  for (let i = 1; i <= 5; i++) await bob.say(thread, `bob ${i}`);
  for (let i = 1; i <= 3; i++) await alice.say(thread, `alice ${i}`);
  await until("alice notices", () => downs.length > 0, 5000);
  const noticed = downs[0]!.at - cut;
  assert.ok(noticed < 2000, `took ${noticed} ms to notice; pings are every 300 ms with a 300 ms timeout`);
  assert.match(downs[0]!.why, /ping/);
  assert.equal(texts(bob, thread).filter((t) => t.startsWith("alice")).length, 0);

  const back = Date.now();
  pa.blackhole(false);
  await until("both sides have everything", () => texts(alice, thread).length === 8 && texts(bob, thread).length === 8, 8000);
  const recovered = Date.now() - back;
  assert.ok(recovered < 3000, `took ${recovered} ms to recover`);
  // Same messages, once each, in each author's order.
  assert.deepEqual(texts(alice, thread).filter((t) => t.startsWith("bob")), ["bob 1", "bob 2", "bob 3", "bob 4", "bob 5"]);
  assert.deepEqual(texts(bob, thread).filter((t) => t.startsWith("alice")), ["alice 1", "alice 2", "alice 3"]);
  await until("alice's sends are confirmed", () => alice.queued().length === 0);
});

test("a machine that slept dials again the moment it wakes", async () => {
  const { alice, bob, la, thread } = await scene();
  await until("alice is connected", () => la.online);
  const wakes: number[] = [];
  la.on("wake", (ms) => wakes.push(ms));
  let lastDown = "";
  la.on("relay", (_u, up, why) => void (up || (lastDown = why)));
  // Block this process the way a suspended laptop is blocked: no timers run.
  const until1 = Date.now() + 1200;
  while (Date.now() < until1);
  await until("the wake is seen", () => wakes.length === 1, 2000);
  assert.ok(wakes[0]! >= 700);
  assert.match(lastDown, /woke/);
  await until("connected again", () => la.online, 2000);
  await bob.say(thread, "after the nap");
  await until("alice reads it", () => texts(alice, thread).includes("after the nap"));
});

test("while the relay is down the wait between dials doubles up to a cap, with jitter, and it reconnects", async () => {
  const relay = await startRelay({});
  const port = relay.port;
  const db = join(dir(), "relay.db");
  await relay.close();
  let r2 = await startRelay({ port, dbPath: db });
  cleanup.push(() => r2.close());
  const alice = await person(r2.url);
  const la = connect(alice, { backoffMs: 50, maxBackoffMs: 400 });
  await until("connected", () => la.online);
  await r2.close();
  // For two seconds the port answers every dial by hanging up. Count the dials.
  const dials: number[] = [];
  const refuser = createServer((s) => {
    dials.push(Date.now());
    s.destroy();
  });
  await new Promise<void>((r) => refuser.listen(port, "127.0.0.1", () => r()));
  await new Promise((r) => setTimeout(r, 2000));
  await new Promise<void>((r) => refuser.close(() => r()));
  const gaps = dials.slice(1).map((t, i) => t - dials[i]!);
  assert.ok(dials.length >= 4 && dials.length <= 14, `${dials.length} dials in two seconds: ${gaps.join(", ")} ms apart`);
  assert.ok(gaps.slice(-3).every((g) => g >= 150 && g <= 700), `the last gaps should sit at the 400 ms cap with jitter: ${gaps.join(", ")}`);
  assert.ok(new Set(gaps.slice(-3).map((g) => Math.round(g / 10))).size > 1, `no jitter: ${gaps.join(", ")}`);
  r2 = await startRelay({ port, dbPath: db });
  const t0 = Date.now();
  await until("reconnected", () => la.online, 3000);
  // The cap is 400 ms, so reconnecting cannot take much longer than that.
  assert.ok(Date.now() - t0 < 1500, `reconnect took ${Date.now() - t0} ms`);
});

test("a relay without ping frames is kept alive with WebSocket pings, and is never sent a frame it does not know", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  cleanup.push(() => new Promise<void>((r) => wss.close(() => r())), () => { for (const c of wss.clients) c.terminate(); });
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const seen: string[] = [];
  let conns = 0;
  wss.on("connection", (ws) => {
    conns++;
    ws.on("message", (raw) => seen.push((JSON.parse(raw.toString()) as { t: string }).t));
    ws.send(JSON.stringify({ t: "ready", device: "d_whatever" })); // a relay from before features
  });
  const alice = await person(url);
  const la = connect(alice);
  await until("connected", () => la.online);
  await new Promise((r) => setTimeout(r, 1500)); // five ping intervals
  assert.ok(la.online);
  assert.equal(conns, 1, "the connection stayed up");
  assert.ok(!seen.includes("ping"), "sent a ping frame to a relay that did not offer it");
});

test("one relay under two names takes one connection, and mail still flows through either name", async () => {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const alice = await person(relay.url);
  const bob = await person(relay.url);
  const la = connect(alice);
  connect(bob);
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await until("pairing", () => bob.contact("alice").state === "active" && alice.contact("bob").state === "active");
  let ups = 0;
  let twin: [string, string] | undefined;
  la.on("relay", (_u, up) => void (up && ups++));
  la.on("twin", (u, of) => (twin = [u, of]));
  const other = `ws://localhost:${relay.port}`;
  alice.relayBook.add(other, null, Date.now());
  await until("alice sees the two names are one relay", () => twin !== undefined);
  assert.deepEqual([...twin!].sort(), [other, relay.url].sort());
  const settled = ups;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(ups, settled, "the two connections kept replacing each other");
  assert.equal(la.connected().length, 1);
  assert.match(alice.relayBook.status().find((s) => s.url === twin![0])!.error ?? "", /same relay as/);

  // Bob's mail reaches Alice, and hers reaches him, whichever name carries it.
  const thread = await bob.openThread("alice", "two names");
  await bob.say(thread, "hello");
  await until("alice reads bob", () => texts(alice, thread).length === 1);
  await alice.say(thread, "back");
  await until("bob reads alice", () => texts(bob, thread).length === 2);

  // When the name that carries the connection is removed, the other dials again.
  if (twin![1] === other) {
    alice.relayBook.remove(other, Date.now());
    await until("alice is back on her home name", () => la.connected().join() === relay.url);
  }
});

test("a relay that claims another relay's id does not stop the daemon dialling that one", async () => {
  const honest = await startRelay();
  cleanup.push(() => honest.close());
  // A relay that copies the honest relay's id into its ready frame.
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  cleanup.push(() => new Promise<void>((r) => wss.close(() => r())), () => { for (const c of wss.clients) c.terminate(); });
  wss.on("connection", (ws) => ws.send(JSON.stringify({ t: "ready", device: "d_whatever", features: ["ping"], id: honest.id })));
  const alice = await person(honest.url);
  const la = connect(alice);
  let twins = 0;
  la.on("twin", () => twins++);
  await until("on the honest relay", () => la.online);
  alice.relayBook.add(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`, null, Date.now());
  await until("on both", () => la.connected().length === 2);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(twins, 0);
  assert.ok(la.connected().includes(honest.url));
});
