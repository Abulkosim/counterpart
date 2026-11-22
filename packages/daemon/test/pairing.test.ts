// Short-code pairing between two real daemons (in process) and a real relay.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import WebSocket, { WebSocketServer } from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PairCode, JoinerRun, RELAY_AUTH_DOMAIN, encodePairMsg, generateSigningKey, issueDevice, parseCode, parsePairMsg, relayAuthMessage, sign,
} from "@counterpart/protocol";
import { type Relay, startRelay } from "@counterpart/relay";
import { Counterpart, OLD_RELAY, PairingEngine, PairingStore, RelayLink } from "../src/index.ts";

const dirs: string[] = [];
const stops: (() => unknown)[] = [];
after(async () => {
  for (const s of stops.reverse()) await s();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function relay(): Promise<Relay> {
  const r = await startRelay();
  stops.push(() => r.close());
  return r;
}
async function person(r: { url: string }): Promise<{ node: Counterpart; store: PairingStore; link: RelayLink; engine: PairingEngine; lines: string[] }> {
  const home = mkdtempSync(join(tmpdir(), "cpart-pair-"));
  dirs.push(home);
  const node = await Counterpart.init(home, { relay: r.url });
  const link = new RelayLink(node, { pollMs: 20 }).start();
  const engine = new PairingEngine(node, link, { pollMs: 20 }).start();
  const lines: string[] = [];
  engine.onLine = (l) => lines.push(l);
  const store = new PairingStore(home);
  stops.push(() => link.stop(), () => engine.stop(), () => store.close(), () => node.close());
  return { node, store, link, engine, lines };
}
async function until<T>(what: string, f: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function code(p: Awaited<ReturnType<typeof person>>, name: string): Promise<{ id: string; code: PairCode }> {
  const id = p.store.requestInvite(name, p.node.relay);
  const v = await until("a code", () => p.store.get(id)?.code ?? undefined);
  return { id, code: parseCode(v) };
}

test("a code pairs two people with no safety code to compare", async () => {
  const r = await relay();
  const [alice, bob] = [await person(r), await person(r)];
  const { id, code: c } = await code(alice, "bob");
  const j = bob.store.requestJoin(c, "alice", bob.node.relay);
  await until("both sides done", () => alice.store.get(id)?.state === "done" && bob.store.get(j)?.state === "done");
  assert.equal(alice.node.contact("bob").rootKey, bob.node.me.rootKey);
  assert.equal(bob.node.contact("alice").rootKey, alice.node.me.rootKey);
  assert.equal(alice.node.contact("bob").state, "active");
  // They can talk at once.
  const t = await bob.node.openThread("alice", "hello");
  await bob.node.say(t, "hi");
  await until("alice to read it", () => alice.node.threads().some((x) => x.id === t && x.events === 2));
  // The words are gone from disk once it is over.
  assert.equal(alice.store.get(id)?.code, null);
});

test("a wrong code fails on both sides, burns the code, and pairs nobody", async () => {
  const r = await relay();
  const [alice, bob, carol] = [await person(r), await person(r), await person(r)];
  const { id, code: c } = await code(alice, "bob");
  const wrong: PairCode = { ...c, words: [c.words[0], c.words[1] === "acid" ? "zoom" : "acid"] };
  const j = bob.store.requestJoin(wrong, "alice", bob.node.relay);
  const a = await until("alice to fail", () => (alice.store.get(id)?.state === "failed" ? alice.store.get(id) : undefined));
  const b = await until("bob to fail", () => (bob.store.get(j)?.state === "failed" ? bob.store.get(j) : undefined));
  assert.match(a.detail!, /Someone tried a wrong code/);
  assert.match(b.detail!, /The code did not match/);
  assert.deepEqual(alice.node.contacts(), []);
  assert.deepEqual(bob.node.contacts(), []);
  // The right code after that finds nothing.
  const k = carol.store.requestJoin(c, "alice", carol.node.relay);
  const cv = await until("carol to fail", () => (carol.store.get(k)?.state === "failed" ? carol.store.get(k) : undefined));
  assert.match(cv.detail!, /No code with that number|already used/);
  // And bob cannot try the same code twice from his home.
  assert.throws(() => bob.store.requestJoin(wrong, "alice", bob.node.relay), /already tried here/);
});

test("your own code, and a name you already use, are refused", async () => {
  const r = await relay();
  const [alice, bob] = [await person(r), await person(r)];
  const { id, code: c } = await code(alice, "bob");
  const j = alice.store.requestJoin(c, "me", alice.node.relay);
  await until("refused", () => alice.store.get(j)?.state === "failed");
  assert.match(alice.store.get(j)!.detail!, /your own code/);
  assert.equal(alice.store.get(id)?.state, "open", "trying your own code does not burn it");
  const j2 = bob.store.requestJoin(c, "alice", bob.node.relay);
  await until("pairing", () => bob.store.get(j2)?.state === "done");
  const again = await code(bob, "carol");
  const k = alice.store.requestJoin(again.code, "bob2", alice.node.relay);
  await until("refused", () => alice.store.get(k)?.state === "failed" && bob.store.get(again.id)?.state === "failed");
  // The joiner notices before it answers, so no guess is spent.
  assert.match(alice.store.get(k)!.detail!, /already your contact, as bob/);
  assert.match(bob.store.get(again.id)!.detail!, /The other side ended the pairing/);
  assert.deepEqual(alice.node.contacts().map((x) => x.name), ["bob"]);
});

// A relay from before nameplates: it closes the connection on any pair.* frame.
async function oldRelay(): Promise<{ url: string; connections: () => number }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((res) => wss.once("listening", res));
  let n = 0;
  wss.on("connection", (ws) => {
    n++;
    ws.send(JSON.stringify({ t: "challenge", nonce: randomBytes(24).toString("base64url") }));
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString()) as { t: string };
      if (f.t === "auth") ws.send(JSON.stringify({ t: "ready", device: "d" }));
      else if (f.t.startsWith("pair.")) ws.close(4002, "bad frame");
    });
  });
  stops.push(() => new Promise((res) => wss.close(res)));
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, connections: () => n };
}

test("a relay without nameplates: both sides give up after three tries, not in a reconnect loop", async () => {
  const r = await oldRelay();
  const alice = await person(r);
  const before = r.connections();
  const id = alice.store.requestInvite("bob", alice.node.relay);
  const a = await until("the inviter to give up", () => (alice.store.get(id)?.state === "failed" ? alice.store.get(id) : undefined), 15_000);
  assert.ok(a.detail!.startsWith(OLD_RELAY), a.detail!);
  assert.match(a.detail!, /cpart invite bob --long/);
  const bob = await person(r);
  const j = bob.store.requestJoin(parseCode("7-acid-acorn"), "alice", bob.node.relay);
  const b = await until("the joiner to give up", () => (bob.store.get(j)?.state === "failed" ? bob.store.get(j) : undefined), 15_000);
  assert.ok(b.detail!.startsWith(OLD_RELAY), b.detail!);
  // Each side: the first connection and one per try, not a reconnect loop.
  await new Promise((res) => setTimeout(res, 1000));
  assert.ok(r.connections() - before <= 10, `${r.connections() - before} connections`);
  // No guess was spent, so the same code can be tried again.
  assert.doesNotThrow(() => bob.store.requestJoin(parseCode("7-acid-acorn"), "alice", bob.node.relay));
});

test("contact names are checked before a code is made or answered", async () => {
  const r = await relay();
  const [alice, bob] = [await person(r), await person(r)];
  assert.throws(() => alice.store.requestInvite("Maya", alice.node.relay), /contact names are/);
  const { code: c } = await code(alice, "bob");
  assert.throws(() => bob.store.requestJoin(c, "Alice", bob.node.relay), /contact names are/);
  // A joiner with the same code in flight cannot start it twice.
  bob.store.requestJoin(c, "alice", bob.node.relay);
  assert.throws(() => bob.store.requestJoin(c, "alice2", bob.node.relay), /being tried here already/);
});

test("if the invite cannot be made after the code checks out, both sides are told", async () => {
  const r = await relay();
  const [alice, bob] = [await person(r), await person(r)];
  const { id, code: c } = await code(alice, "bob");
  // A name that slipped past the checks (written straight into the table).
  const raw = new DatabaseSync(join(alice.node.home, "pairing.db"));
  raw.prepare("UPDATE pairings SET name = 'Bob' WHERE id = ?").run(id);
  raw.close();
  const j = bob.store.requestJoin(c, "alice", bob.node.relay);
  const a = await until("alice to fail", () => (alice.store.get(id)?.state === "failed" ? alice.store.get(id) : undefined));
  assert.match(a.detail!, /the contact could not be made/);
  const b = await until("bob to hear it", () => (bob.store.get(j)?.state === "failed" ? bob.store.get(j) : undefined));
  assert.match(b.detail!, /The other side ended the pairing/);
});

test("an inviter whose daemon restarted closes its code, so the joiner is not left waiting", async () => {
  const r = await relay();
  const [alice, bob] = [await person(r), await person(r)];
  const { id, code: c } = await code(alice, "bob");
  await alice.engine.stop();
  await alice.link.stop();
  const link = new RelayLink(alice.node, { pollMs: 20 }).start();
  const engine = new PairingEngine(alice.node, link, { pollMs: 20 }).start();
  stops.push(() => link.stop(), () => engine.stop());
  assert.match(alice.store.get(id)!.detail!, /restarted/);
  await until("alice back online", () => link.online);
  await new Promise((res) => setTimeout(res, 200));
  const j = bob.store.requestJoin(c, "alice", bob.node.relay);
  const b = await until("bob to be told", () => (bob.store.get(j)?.state === "failed" ? bob.store.get(j) : undefined), 5000);
  assert.match(b.detail!, /No code with that number|ended the pairing/);
});

test("a joiner that proves the code but cannot add the contact says so, and the inviter stops waiting", async () => {
  const r = await relay();
  const alice = await person(r);
  const { id, code: c } = await code(alice, "bob");
  // Bob, by hand: he runs the protocol, then reports a failure after confirming.
  const dev = await issueDevice(generateSigningKey());
  const ws = new WebSocket(r.url);
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  stops.push(() => ws.terminate());
  const take = (t: string, k?: string): Promise<Record<string, unknown>> =>
    until(t, () => {
      const i = frames.findIndex((f) => f.t === t && (!k || (typeof f.body === "string" && (JSON.parse(f.body) as { k: string }).k === k)));
      return i >= 0 ? frames.splice(i, 1)[0] : undefined;
    });
  const send = (f: unknown): void => ws.send(JSON.stringify(f));
  const ch = await take("challenge");
  send({ t: "auth", credential: dev.credential, relay: r.url, sig: sign(dev.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(ch.nonce as string, r.url)) });
  await take("ready");
  send({ t: "pair.claim", nameplate: c.nameplate });
  const run = new JoinerRun({ relay: r.url, nameplate: c.nameplate, words: c.words, credential: dev.credential });
  const step = run.answer(parsePairMsg((await take("pair.msg", "a")).body));
  assert.ok(step.ok);
  send({ t: "pair.send", nameplate: c.nameplate, body: encodePairMsg(step.reply) });
  const fin = run.finish(parsePairMsg((await take("pair.msg", "c")).body));
  assert.ok(fin.ok);
  await until("alice confirmed", () => alice.store.get(id)?.state === "confirmed");
  send({ t: "pair.send", nameplate: c.nameplate, body: encodePairMsg({ v: 1, k: "fail", why: "refused" }) });
  const a = await until("alice to stop waiting", () => (alice.store.get(id)?.state === "failed" ? alice.store.get(id) : undefined));
  assert.match(a.detail!, /The other side ended the pairing/);
  // The invite made for bob's key is gone: a late contact request is refused.
  const db = new DatabaseSync(join(alice.node.home, "state.db"));
  const left = db.prepare("SELECT COUNT(*) AS n FROM invites WHERE for_root = ?").get(dev.credential.rootKey) as { n: number };
  db.close();
  assert.equal(left.n, 0);
});

test("the words do not stay in pairing.db or its log once a pairing ends", async () => {
  const r = await relay();
  const [alice, bob] = [await person(r), await person(r)];
  const { id, code: c } = await code(alice, "bob");
  const j = bob.store.requestJoin(c, "alice", bob.node.relay);
  await until("both sides done", () => alice.store.get(id)?.state === "done" && bob.store.get(j)?.state === "done");
  const leaks = (home: string): string[] =>
    readdirSync(home).filter((f) => f.startsWith("pairing.db")).filter((f) => readFileSync(join(home, f)).includes(Buffer.from(c.words.join("-"))));
  await until("the words to be gone from disk", () => leaks(alice.node.home).length === 0 && leaks(bob.node.home).length === 0);
});
