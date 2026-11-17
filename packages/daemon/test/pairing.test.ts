// Short-code pairing between two real daemons (in process) and a real relay.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PairCode, parseCode } from "@counterpart/protocol";
import { type Relay, startRelay } from "@counterpart/relay";
import { Counterpart, PairingEngine, PairingStore, RelayLink } from "../src/index.ts";

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
async function person(r: Relay): Promise<{ node: Counterpart; store: PairingStore; link: RelayLink; engine: PairingEngine; lines: string[] }> {
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
  assert.match(bob.store.get(again.id)!.detail!, /already your contact, as alice/);
  assert.match(alice.store.get(k)!.detail!, /The other side ended the pairing/);
  assert.deepEqual(alice.node.contacts().map((x) => x.name), ["bob"]);
});
