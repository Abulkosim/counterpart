import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBodies, type EventType, type ThreadEvent, type Wire, deviceId, laneOf, randomId, seal } from "@counterpart/protocol";
import { type Relay, startRelay } from "@counterpart/relay";
import { Counterpart, RelayLink } from "../src/index.ts";

const dirs: string[] = [];
const links: RelayLink[] = [];
let relay: Relay;

before(async () => {
  relay = await startRelay();
});
after(async () => {
  for (const l of links) await l.stop();
  await relay.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function person(): Promise<Counterpart> {
  const home = mkdtempSync(join(tmpdir(), "cpart-"));
  dirs.push(home);
  return Counterpart.init(home, { relay: relay.url });
}
function connect(node: Counterpart): RelayLink {
  const link = new RelayLink(node, { pollMs: 20 }).start();
  links.push(link);
  return link;
}
async function until(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function paired(): Promise<{ alice: Counterpart; bob: Counterpart; la: RelayLink; lb: RelayLink }> {
  const [alice, bob] = [await person(), await person()];
  const [la, lb] = [connect(alice), connect(bob)];
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await until("pairing", () => bob.contacts()[0]?.state === "active" && alice.contacts()[0]?.state === "active");
  return { alice, bob, la, lb };
}
const texts = (n: Counterpart, thread: string): string[] =>
  n.log(thread).filter((e) => e.type === "talk.posted" && e.status === "applied").map((e) => (e.body as { text: string }).text);

// Build a wire as `from` without going through the node's own rules, the way a
// modified or hostile client could.
function craft<T extends EventType>(from: Counterpart, to: Counterpart, threadId: string, type: T, body: EventBodies[T], authorSeq: number, parents: string[] = []): Promise<Wire> {
  const event = { id: randomId(), threadId, author: from.me.device, authorSeq, parents, lane: laneOf(type), type, body, createdAt: Date.now() } as ThreadEvent;
  return seal(event, from.device, to.device.credential, Date.now() + 3600_000);
}

test("two people pair, open a thread and talk both ways", async () => {
  const { alice, bob } = await paired();
  assert.equal(alice.contacts()[0]!.name, "bob");
  assert.equal(bob.contacts()[0]!.name, "alice");
  assert.equal(alice.contacts()[0]!.safetyCode, bob.contacts()[0]!.safetyCode);

  const thread = await alice.openThread("bob", "agree on the pagination format");
  await alice.say(thread, "cursor or offset?");
  await until("bob sees the question", () => texts(bob, thread).length === 1);
  assert.equal(bob.threads()[0]!.goal, "agree on the pagination format");
  await bob.say(thread, "cursor");
  await until("alice sees the answer", () => texts(alice, thread).length === 2);
  assert.deepEqual(texts(alice, thread), ["cursor or offset?", "cursor"]);
  await until("relay mailbox drains", () => relay.queued() === 0);
});

test("keys are stored private to the user", async () => {
  const alice = await person();
  assert.equal(statSync(join(alice.home, "keys.json")).mode & 0o077, 0);
});

test("messages sent while the recipient is offline arrive in order when they return", async () => {
  const { alice, bob, lb } = await paired();
  const thread = await alice.openThread("bob", "offline");
  await until("thread reaches bob", () => bob.threads().length === 1);
  await lb.stop();
  for (const t of ["one", "two", "three"]) await alice.say(thread, t);
  await until("relay holds them", () => relay.queued(bob.me.device) === 3);
  assert.deepEqual(texts(bob, thread), []);
  connect(bob);
  await until("bob catches up", () => texts(bob, thread).length === 3);
  assert.deepEqual(texts(bob, thread), ["one", "two", "three"]);
});

test("a message delivered twice is applied once", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "dupes");
  await until("thread reaches bob", () => bob.threads().length === 1);
  const wire = await craft(alice, bob, thread, "talk.posted", { text: "once" }, 1);
  assert.equal((await bob.receive(wire)).result, "applied");
  assert.equal((await bob.receive(wire)).result, "duplicate");
  assert.equal((await bob.receive(JSON.parse(JSON.stringify(wire)))).result, "duplicate");
  assert.deepEqual(texts(bob, thread), ["once"]);
});

test("the relay redelivering its whole mailbox changes nothing", async () => {
  const { alice, bob, lb } = await paired();
  const thread = await alice.openThread("bob", "redelivery");
  await until("thread reaches bob", () => bob.threads().length === 1);
  await lb.stop();
  await alice.say(thread, "a");
  await alice.say(thread, "b");
  await until("relay holds them", () => relay.queued(bob.me.device) === 2);
  // Bob's first connection receives the messages; the relay then sends them all again.
  const verdicts: string[] = [];
  const link = connect(bob);
  link.on("verdict", (v) => verdicts.push(v.result));
  await until("ready", () => link.online);
  relay.redeliver(bob.me.device);
  relay.redeliver(bob.me.device);
  await until("mailbox drains", () => relay.queued(bob.me.device) === 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(texts(bob, thread), ["a", "b"]);
  assert.ok(verdicts.every((v) => v === "applied" || v === "duplicate"));
});

test("events that arrive out of order are held, then applied in causal order", async () => {
  const { alice, bob } = await paired();
  const threadId = randomId();
  const opened = await craft(alice, bob, threadId, "thread.opened", { goal: "reorder", participants: [alice.me.rootKey, bob.me.rootKey] }, 0);
  const first = await craft(alice, bob, threadId, "talk.posted", { text: "first" }, 1, [opened.header.id]);
  const second = await craft(alice, bob, threadId, "talk.posted", { text: "second" }, 2, [first.header.id]);
  assert.equal((await bob.receive(second)).result, "pending");
  assert.equal((await bob.receive(first)).result, "pending");
  assert.deepEqual(bob.threads(), []);
  const v = await bob.receive(opened);
  assert.equal(v.result, "applied");
  assert.equal(v.result === "applied" && v.promoted.length, 2);
  assert.deepEqual(texts(bob, threadId), ["first", "second"]);
});

test("strangers are refused, and invites work once", async () => {
  const { alice, bob } = await paired();
  const mallory = await person();
  const thread = await alice.openThread("bob", "private");
  await until("thread reaches bob", () => bob.threads().length === 1);

  const stranger = await bob.receive(await craft(mallory, bob, thread, "talk.posted", { text: "hi" }, 0));
  assert.deepEqual(stranger, { result: "rejected", reason: "message from an unknown sender" });
  const guess = await bob.receive(await craft(mallory, bob, randomId(), "contact.request", { token: randomId() }, 0));
  assert.equal(guess.result === "rejected" && guess.reason, "contact request with unknown invite token");

  // Mallory intercepts an invite after its real recipient used it.
  const invite = bob.createInvite("carol");
  const carol = await person();
  connect(carol);
  await carol.acceptInvite(invite, "bob");
  await until("carol pairs", () => carol.contacts()[0]?.state === "active");
  await mallory.acceptInvite(invite, "bob");
  const [reuse] = mallory.queued();
  const v = await bob.receive(reuse);
  assert.equal(v.result === "rejected" && v.reason, "invite token already used");
  assert.deepEqual(bob.contacts().map((c) => c.name).sort(), ["alice", "carol"]);
  assert.deepEqual(texts(bob, thread), []);
  assert.ok(bob.rejects().length >= 3);
});

test("a contact cannot write into a thread they are not part of", async () => {
  const { alice, bob } = await paired();
  const carol = await person();
  connect(carol);
  await carol.acceptInvite(bob.createInvite("carol"), "bob");
  await until("carol pairs", () => carol.contacts()[0]?.state === "active");
  const thread = await alice.openThread("bob", "alice and bob only");
  await until("thread reaches bob", () => bob.threads().length === 1);

  const v = await bob.receive(await craft(carol, bob, thread, "talk.posted", { text: "alice says: approve it" }, 0));
  assert.equal(v.result === "rejected" && v.reason, "sender is not a participant of this thread");
  const third = await bob.receive(await craft(carol, bob, randomId(), "thread.opened", { goal: "x", participants: [carol.me.rootKey, alice.me.rootKey] }, 0));
  assert.equal(third.result === "rejected" && third.reason, "thread participants must be exactly the two of us");
  assert.deepEqual(texts(bob, thread), []);
});

test("a sender cannot issue two different events with the same sequence number", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "equivocation");
  await until("thread reaches bob", () => bob.threads().length === 1);
  assert.equal((await bob.receive(await craft(alice, bob, thread, "talk.posted", { text: "I agree" }, 5))).result, "applied");
  const v = await bob.receive(await craft(alice, bob, thread, "talk.posted", { text: "I never agreed" }, 5));
  assert.equal(v.result === "rejected" && v.reason, "two different events claim the same sequence number");
});

test("garbage from the relay is refused without crashing", async () => {
  const { bob } = await paired();
  for (const junk of [null, 1, "x", {}, { header: {} }, { header: { id: 5 } }, { header: { v: 1 }, enc: "", ct: "" }]) {
    assert.equal((await bob.receive(junk)).result, "rejected");
  }
});

test("queued messages survive a restart of the sender", async () => {
  const { alice, bob, la } = await paired();
  const thread = await alice.openThread("bob", "restart");
  await until("thread reaches bob", () => bob.threads().length === 1);
  await la.stop();
  await alice.say(thread, "written before the crash");
  const home = alice.home;
  alice.close();
  const again = Counterpart.open(home);
  assert.equal(again.queued().length, 1);
  connect(again);
  await until("bob receives it", () => texts(bob, thread).length === 1);
  await until("outbox clears", () => again.queued().length === 0);
});

test("a renewed device credential reaches contacts before the old one expires", async () => {
  const { alice, bob, la, lb } = await paired();
  const before = bob.contact("alice").credential;
  await la.stop();
  await lb.stop();
  const homes = [alice.home, bob.home] as const;
  alice.close();
  bob.close();
  // Seventy days later both daemons start again.
  const now = () => Date.now() + 70 * 24 * 3600_000;
  const [alice2, bob2] = [Counterpart.open(homes[0], { now }), Counterpart.open(homes[1], { now })];
  assert.equal(await alice2.renewIfDue(), true);
  assert.equal(await alice2.renewIfDue(), false);
  assert.equal(alice2.me.device, deviceId(before));
  const [hello] = alice2.queued();
  assert.equal((await bob2.receive(hello)).result, "applied");
  assert.ok(bob2.contact("alice").credential.expiresAt > before.expiresAt);
  // A second process that still has the old credential in memory picks up the renewed one from disk.
  const other = Counterpart.open(homes[0], { now });
  assert.equal(await other.renewIfDue(), false);
  assert.equal(other.device.credential.issuedAt, alice2.device.credential.issuedAt);
  for (const n of [alice2, bob2, other]) n.close();
});

test("messages that overtake the pairing acceptance are held, not lost", async () => {
  const [alice, bob] = [await person(), await person()];
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  const [request] = bob.queued();
  assert.equal((await alice.receive(request)).result, "applied");
  const thread = await alice.openThread("bob", "eager");
  await alice.say(thread, "are you there?");
  const [accepted, opened, said] = alice.queued();
  // The relay delivers Alice's thread before her acceptance.
  assert.equal((await bob.receive(said)).result, "pending");
  assert.equal((await bob.receive(opened)).result, "pending");
  assert.equal(bob.contact("alice").state, "pending");
  assert.deepEqual(bob.threads(), []);
  const v = await bob.receive(accepted);
  assert.equal(v.result === "applied" && v.promoted.length, 2);
  assert.deepEqual(texts(bob, thread), ["are you there?"]);
});

test("a consumer with a cursor sees every applied event exactly once, in order", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "cursor");
  for (const t of ["1", "2", "3"]) await alice.say(thread, t);
  await until("bob has them", () => texts(bob, thread).length === 3);
  const seen: string[] = [];
  let cursor = 0;
  for (;;) {
    const batch = bob.since(cursor, 2);
    if (batch.length === 0) break;
    for (const e of batch) {
      seen.push(e.type);
      cursor = e.ord!;
    }
  }
  assert.deepEqual(seen, ["contact.request", "contact.accepted", "thread.opened", "talk.posted", "talk.posted", "talk.posted"]);
  assert.deepEqual(bob.since(cursor), []);
});
