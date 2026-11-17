import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Relay, startRelay } from "@counterpart/relay";
import { Counterpart, type LinkOptions, RelayLink } from "../src/index.ts";

const dirs: string[] = [];
const links: RelayLink[] = [];
const relays: Relay[] = [];
after(async () => {
  for (const l of links) await l.stop();
  for (const r of relays) await r.close().catch(() => {}); // some were closed by their test
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function relay(opts: Parameters<typeof startRelay>[0] = {}): Promise<Relay> {
  const r = await startRelay(opts);
  relays.push(r);
  return r;
}
async function person(url: string, relayAs?: string): Promise<Counterpart> {
  const home = mkdtempSync(join(tmpdir(), "cpart-relays-"));
  dirs.push(home);
  return Counterpart.init(home, { relay: url, ...(relayAs ? { relayAs } : {}) });
}
function connect(node: Counterpart, opts: LinkOptions = {}): RelayLink {
  const link = new RelayLink(node, { pollMs: 20, tickMs: 50, ...opts });
  link.on("error", () => {});
  links.push(link);
  return link.start();
}
async function until(what: string, cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const texts = (n: Counterpart, thread: string): string[] =>
  n.log(thread).filter((e) => e.type === "talk.posted" && e.status === "applied").map((e) => (e.body as { text: string }).text);

async function pair(a: Counterpart, b: Counterpart): Promise<void> {
  await b.acceptInvite(a.createInvite("bob"), "alice");
  await until("pairing", () => b.contact("alice").state === "active" && a.contact("bob").state === "active");
}

test("an identity made before relay lists keeps its relay and its contacts' relay", async () => {
  const r = await relay();
  const alice = await person(r.url);
  const bob = await person(r.url);
  connect(alice);
  connect(bob);
  await pair(alice, bob);
  const home = alice.home;
  // What an older version left behind: no relay tables at all.
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("DROP TABLE my_relays; DROP TABLE relay_meta; DROP TABLE contact_relays; DROP TABLE relay_status;");
  db.close();
  const again = Counterpart.open(home);
  try {
    assert.deepEqual(again.relayBook.mine(), [{ url: r.url, as: null, home: true, leaving: false }]);
    assert.equal(again.relay, r.url);
    assert.deepEqual(again.relayBook.their(again.contact("bob").rootKey, again.contact("bob").relay).relays, [r.url]);
    assert.equal(again.relayBook.version(), 0);
  } finally {
    again.close();
  }
});

test("a relay answers to every name it is given and to no other", async () => {
  const r = await relay({ urls: ["ws://127.0.0.1:1/x", "ws://host.docker.internal:7447"] });
  assert.deepEqual(r.urls, ["ws://127.0.0.1:1/x", "ws://host.docker.internal:7447"]);
  const open = await relay();
  assert.ok(open.urls.includes(`ws://host.docker.internal:${open.port}`), "a loopback relay answers to the container name");
  await assert.rejects(startRelay({ urls: ["http://example.com"] }), /not a relay address/);
});

test("two names for one relay: one side dials 127.0.0.1, the other host.docker.internal", async () => {
  const r = await relay();
  // Bob reaches the same relay through an address only he uses; here a second
  // loopback name stands in for host.docker.internal.
  const other = `ws://localhost:${r.port}`;
  const alice = await person(r.url);
  const bob = await person(other, r.url);
  connect(alice);
  connect(bob);
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await until("pairing", () => bob.contact("alice").state === "active");
  const thread = await alice.openThread("bob", "names");
  await alice.say(thread, "from 127.0.0.1");
  await until("bob reads it", () => texts(bob, thread).length === 1);
  await bob.say(thread, "from the other name");
  await until("alice reads it", () => texts(alice, thread).length === 2);
  assert.deepEqual(bob.relayBook.route([r.url]).preferred, [other], "bob sends alice's mail through his name for her relay");
});

test("a second relay: contacts learn it, and mail moves to it when the first one dies", async () => {
  const r1 = await relay();
  const r2 = await relay();
  const alice = await person(r1.url);
  const bob = await person(r1.url);
  const la = connect(alice);
  connect(bob);
  await pair(alice, bob);
  const thread = await alice.openThread("bob", "two relays");
  await until("bob has the thread", () => bob.threads().length === 1);

  // Both add r2. Each learns the other's list from a signed contact.relays.
  alice.relayBook.add(r2.url, null, Date.now());
  bob.relayBook.add(r2.url, null, Date.now());
  await until("alice connected to both", () => la.connected().length === 2);
  const bobRoot = alice.contact("bob").rootKey;
  await until("each has the other's list and confirmed it", () =>
    alice.relayBook.their(bobRoot, r1.url).relays.length === 2 && alice.relayBook.unconfirmed([{ rootKey: bobRoot, relay: r1.url }]).length === 0 && bob.relayBook.unconfirmed([{ rootKey: bob.contact("alice").rootKey, relay: r1.url }]).length === 0,
  );

  // r1 goes away for good. After the fallback wait, mail goes through r2.
  await r1.close();
  await alice.say(thread, "after r1 died");
  await until("bob reads it through r2", () => texts(bob, thread).includes("after r1 died"), 15_000);
  await bob.say(thread, "and back");
  await until("alice reads the answer", () => texts(alice, thread).includes("and back"), 15_000);
});

test("relay move: add, announce, wait for the contact, then drop the old one", async () => {
  const r1 = await relay();
  const r2 = await relay();
  const alice = await person(r1.url);
  const bob = await person(r1.url);
  const la = connect(alice);
  const lb = connect(bob);
  await pair(alice, bob);
  const contacts = (): { rootKey: string; relay: string }[] => alice.contacts();

  // Bob does not use r2. Alice's move cannot finish: Bob could not reach her there.
  const { from } = alice.relayBook.moveHome(r2.url, null, Date.now());
  assert.equal(from, r1.url);
  assert.equal(alice.relay, r2.url);
  assert.deepEqual(alice.relayBook.leaving().map((r) => r.url), [r1.url]);
  const bobRoot = alice.contact("bob").rootKey;
  await until("bob has alice's new list", () => bob.relayBook.their(bob.contact("alice").rootKey, r1.url).relays[0] === r2.url);
  await until("alice knows bob has it", () => alice.relayBook.their(bobRoot, r1.url).seen === alice.relayBook.version());
  assert.deepEqual(alice.relayBook.unconfirmed(contacts()), [bobRoot], "bob still only uses r1");
  assert.equal(bob.relayBook.missing(bob.contacts()).length, 0, "alice still lists r1, so bob can reach her");

  bob.relayBook.add(r2.url, null, Date.now());
  await until("bob is on r2", () => lb.connected().includes(r2.url));
  await until("alice sees bob uses r2", () => alice.relayBook.unconfirmed(contacts()).length === 0);
  alice.relayBook.remove(r1.url, Date.now());
  await until("alice left r1", () => la.connected().join() === r2.url);

  const thread = await bob.openThread("alice", "after the move");
  await bob.say(thread, "still here");
  await until("alice reads bob through r2", () => texts(alice, thread).length === 1);
  await alice.say(thread, "me too");
  await until("bob reads alice", () => texts(bob, thread).length === 2);
});
