import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBodies, type EventType, type ThreadEvent, type Wire, laneOf, randomId, seal } from "@counterpart/protocol";
import { type Relay, startRelay } from "@counterpart/relay";
import { Counterpart, RelayLink, type Verdict } from "../src/index.ts";

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
let t = Date.now();
const now = (): number => t;
const advance = (ms: number): void => void (t += ms);
let relay: Relay;

before(async () => {
  relay = await startRelay();
});
after(async () => {
  for (const s of stops) await s();
  await relay.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function person(opts: { real?: boolean; receiptDelayMs?: number; resendAfterMs?: number } = {}): Promise<Counterpart> {
  const home = mkdtempSync(join(tmpdir(), "cpart-"));
  dirs.push(home);
  const { real, ...rest } = opts;
  return Counterpart.init(home, { relay: relay.url, ...(real ? {} : { now }), ...rest });
}
// Hand queued messages straight to the recipient, except the ones `drop` picks.
async function carry(from: Counterpart, to: Counterpart, drop: (w: Wire) => boolean = () => false): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const wire of from.queued()) {
    if (wire.header.to !== to.me.device) continue;
    if (!drop(wire)) out.push(await to.receive(wire));
    from.markOutbox(wire.header.id, "stored");
  }
  return out;
}
async function pair(a: Counterpart, b: Counterpart, aCallsB: string, bCallsA: string): Promise<void> {
  await b.acceptInvite(a.createInvite(aCallsB), bCallsA);
  await carry(b, a);
  await carry(a, b);
}
async function paired(): Promise<{ alice: Counterpart; bob: Counterpart }> {
  const [alice, bob] = [await person(), await person()];
  await pair(alice, bob, "bob", "alice");
  return { alice, bob };
}
const texts = (n: Counterpart, thread: string): string[] =>
  n.threads().some((x) => x.id === thread) ? n.log(thread).filter((e) => e.type === "talk.posted" && e.status === "applied").map((e) => (e.body as { text: string }).text) : [];
function craft<T extends EventType>(from: Counterpart, to: Counterpart, threadId: string, type: T, body: EventBodies[T], over: Partial<ThreadEvent> = {}): Promise<Wire> {
  const event = { id: randomId(), threadId, author: from.me.device, authorSeq: 0, parents: [], lane: laneOf(type), type, body, createdAt: now(), ...over } as ThreadEvent;
  return seal(event, from.device, to.device.credential, now() + 3600_000);
}
const reason = (v: Verdict): string => (v.result === "rejected" ? v.reason : v.result);
async function until(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("a lost message is asked for after the threshold and the thread recovers", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "resend");
  await carry(alice, bob);
  const lost = await alice.say(thread, "one");
  await alice.say(thread, "two");
  await alice.say(thread, "three");
  await carry(alice, bob, (w) => w.header.id === lost.id);
  assert.deepEqual(texts(bob, thread), []);
  assert.equal(bob.log(thread).filter((e) => e.status === "pending").length, 2);

  assert.equal(await bob.requestMissing(), 0, "asked before the threshold");
  advance(31_000);
  assert.equal(await bob.requestMissing(), 1);
  assert.equal(await bob.requestMissing(), 0, "asked twice in a row");
  const request = bob.queued().at(-1)!;
  assert.equal((await alice.receive(request)).result, "control");
  bob.markOutbox(request.header.id, "stored");
  assert.equal(bob.outboxState(request.header.id), undefined, "a sent request stays in the outbox");

  assert.deepEqual(alice.queued().map((w) => w.header.id), [lost.id]);
  const v = (await carry(alice, bob))[0]!;
  assert.equal(v.result === "applied" && v.promoted.length, 2);
  assert.deepEqual(texts(bob, thread), ["one", "two", "three"]);
  // Neither side's log or cursor shows the request.
  for (const n of [alice, bob]) {
    assert.ok(n.since(0, 1000).every((e) => !e.type.startsWith("thread.re")));
    assert.equal(n.log(thread).length, 4);
  }
  advance(3600_000);
  assert.equal(await bob.requestMissing(), 0, "asked with nothing held");
});

test("a thread whose opening was lost is rebuilt one missing parent at a time", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "walk back");
  await alice.say(thread, "one");
  const last = await alice.say(thread, "two");
  await carry(alice, bob, (w) => w.header.id !== last.id);
  assert.deepEqual(bob.threads(), []);
  for (let round = 0; round < 2; round++) {
    advance(3600_000);
    assert.equal(await bob.requestMissing(), 1, `round ${round}`);
    assert.deepEqual((await carry(bob, alice)).map((v) => v.result), ["control"]);
    await carry(alice, bob);
  }
  assert.deepEqual(texts(bob, thread), ["one", "two"]);
});

test("a resend request gets only the responder's own events in the requester's own thread", async () => {
  const { alice, bob } = await paired();
  const mallory = await person();
  await pair(alice, mallory, "mallory", "alice");
  const withBob = await alice.openThread("bob", "private");
  const secret = await alice.say(withBob, "for bob only");
  const other = await alice.openThread("bob", "another thread");
  const elsewhere = await alice.say(other, "elsewhere");
  const withMallory = await alice.openThread("mallory", "public");
  await carry(alice, bob);
  await carry(alice, mallory);
  const fromBob = await bob.say(withBob, "bob wrote this");
  await carry(bob, alice);
  assert.deepEqual(alice.queued(), []);

  const refused: [string, Wire, RegExp][] = [
    ["someone else's thread", await craft(mallory, alice, withBob, "thread.resend", { ids: [secret.id] }), /not a participant/],
    ["a thread that does not exist", await craft(mallory, alice, randomId(), "thread.resend", { ids: [secret.id] }), /not a participant/],
    ["her own thread, someone else's event", await craft(mallory, alice, withMallory, "thread.resend", { ids: [secret.id] }), /names nothing/],
    ["an id from another thread of his", await craft(bob, alice, other, "thread.resend", { ids: [secret.id] }), /names nothing/],
    ["with a sequence number", await craft(bob, alice, withBob, "thread.resend", { ids: [secret.id] }, { authorSeq: 7 }), /stand alone/],
    ["with parents", await craft(bob, alice, withBob, "thread.resend", { ids: [secret.id] }, { parents: [secret.id] }), /stand alone/],
    ["a stranger", await craft(await person(), alice, withBob, "thread.resend", { ids: [secret.id] }), /unknown sender/],
  ];
  for (const [what, wire, why] of refused) {
    assert.match(reason(await alice.receive(wire)), why, what);
    assert.deepEqual(alice.queued(), [], what);
  }
  // Bob's own event and an id nobody wrote are skipped; the one event of Alice's is sent.
  advance(31_000);
  assert.equal((await alice.receive(await craft(bob, alice, withBob, "thread.resend", { ids: [fromBob.id, randomId(), secret.id] }))).result, "control");
  assert.deepEqual(alice.queued().map((w) => w.header.id), [secret.id]);
  assert.equal(alice.queued()[0]!.header.to, bob.me.device);
  assert.ok(![elsewhere.id].includes(alice.queued()[0]!.header.id));
  assert.deepEqual((await carry(alice, bob)).map((v) => v.result), ["duplicate"]);
});

test("the responder limits how often it answers and how often one event is sent again", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "limits");
  const e = await alice.say(thread, "again and again");
  await carry(alice, bob);
  const ask = (): Promise<Wire> => craft(bob, alice, thread, "thread.resend", { ids: [e.id] });

  assert.equal((await alice.receive(await ask())).result, "control");
  for (let i = 0; i < 50; i++) assert.match(reason(await alice.receive(await ask())), /too soon/);
  assert.equal(alice.queued().length, 1);
  await carry(alice, bob);
  // Five times in all for one event, however patiently it is asked for.
  for (let i = 1; i < 5; i++) {
    advance(31_000);
    assert.equal((await alice.receive(await ask())).result, "control");
    assert.equal((await carry(alice, bob)).length, 1);
  }
  advance(31_000);
  assert.match(reason(await alice.receive(await ask())), /names nothing/);
  assert.deepEqual(alice.queued(), []);
  // A replayed request is a request: it meets the same limits.
  const replay = await ask();
  advance(31_000);
  assert.match(reason(await alice.receive(replay)), /names nothing/);
  assert.match(reason(await alice.receive(replay)), /too soon/);
});

test("the responder answers a contact in at most 20 threads per ten minutes", async () => {
  const { alice, bob } = await paired();
  const made: [string, string][] = [];
  for (let i = 0; i < 21; i++) {
    const thread = await alice.openThread("bob", `thread ${i}`);
    made.push([thread, (await alice.say(thread, "x")).id]);
  }
  await carry(alice, bob);
  const results: string[] = [];
  for (const [thread, id] of made) results.push(reason(await alice.receive(await craft(bob, alice, thread, "thread.resend", { ids: [id] }))));
  assert.deepEqual(results.slice(0, 20), Array(20).fill("control"));
  assert.match(results[20]!, /too many/);
  assert.equal(alice.queued().length, 20);
});

test("the requester gives up on parents that never come, and is slow across threads", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "bogus");
  await carry(alice, bob);
  // Alice turns hostile: an event whose parent does not exist.
  assert.equal((await bob.receive(await craft(alice, bob, thread, "talk.posted", { text: "orphan" }, { authorSeq: 1, parents: [randomId()] }))).result, "pending");
  let asked = 0;
  // Six days of hourly passes. After a week with no answer it starts over.
  for (let i = 0; i < 144; i++) {
    advance(3600_000);
    asked += await bob.requestMissing();
    for (const w of bob.queued()) bob.markOutbox(w.header.id, "stored");
  }
  assert.equal(asked, 8);

  // Ten more threads with something missing: five requests in any one minute.
  for (let i = 0; i < 10; i++) assert.equal((await bob.receive(await craft(alice, bob, randomId(), "talk.posted", { text: "orphan" }, { authorSeq: 1, parents: [randomId()] }))).result, "pending");
  advance(31_000);
  assert.equal(await bob.requestMissing(), 5);
  assert.equal(await bob.requestMissing(), 0);
  advance(61_000);
  assert.equal(await bob.requestMissing(), 5);
});

test("a request carries at most 16 ids, and only ones that are not already here", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "many");
  await carry(alice, bob);
  const opened = alice.log(thread)[0]!.id;
  const bogus = Array.from({ length: 20 }, () => randomId());
  await bob.receive(await craft(alice, bob, thread, "talk.posted", { text: "a" }, { authorSeq: 1, parents: [opened, ...bogus.slice(0, 15)] }));
  await bob.receive(await craft(alice, bob, thread, "talk.posted", { text: "b" }, { authorSeq: 2, parents: bogus.slice(4) }));
  advance(31_000);
  assert.equal(await bob.requestMissing(), 1);
  // Alice can parse it (17 ids would be a bad body) and finds nothing of hers in it.
  assert.deepEqual((await carry(bob, alice)).map(reason), ["resend request names nothing of mine that can be sent again"]);
  assert.deepEqual(alice.queued(), []);
});

test("a receipt moves my event from stored to received, and covers several events at once", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "receipts");
  const a = await alice.say(thread, "one");
  const b = await alice.say(thread, "two");
  assert.equal(alice.delivery(a.id), "queued");
  await carry(alice, bob);
  assert.equal(alice.delivery(a.id), "stored");
  assert.equal(await bob.sendReceipts(), 0, "sent before the delay");
  advance(1001);
  assert.equal(await bob.sendReceipts(), 1);
  assert.equal(await bob.sendReceipts(), 0);
  const receipt = bob.queued().at(-1)!;
  assert.deepEqual((await carry(bob, alice)).map((v) => v.result), ["control"]);
  assert.equal(bob.outboxState(receipt.header.id), undefined);
  assert.equal(alice.delivery(a.id), "received");
  assert.equal(alice.delivery(b.id), "received");
  assert.equal(alice.outboxState(a.id), "stored");
  assert.deepEqual(alice.log(thread).map((e) => e.delivery), ["received", "received", "received"]);
  assert.deepEqual(bob.log(thread).map((e) => e.delivery), [undefined, undefined, undefined]);
  // A receipt is not receipted, and is not an event in anyone's log.
  advance(60_000);
  assert.equal(await alice.sendReceipts(), 0);
  assert.equal(alice.log(thread).length, 3);
  assert.equal(alice.since(0, 1000).filter((e) => e.type === "thread.received").length, 0);
  // Sending an event again does not forget that it was received.
  await alice.receive(await craft(bob, alice, thread, "thread.resend", { ids: [a.id] }));
  assert.equal(alice.outboxState(a.id), "queued");
  assert.equal(alice.delivery(a.id), "received");
});

test("a receipt counts only for the sender's own thread", async () => {
  const { alice } = await paired();
  const mallory = await person();
  await pair(alice, mallory, "mallory", "alice");
  const withBob = await alice.openThread("bob", "private");
  const e = await alice.say(withBob, "has bob got this?");
  const withMallory = await alice.openThread("mallory", "public");
  await carry(alice, mallory);
  for (const w of alice.queued()) alice.markOutbox(w.header.id, "stored");
  assert.match(reason(await alice.receive(await craft(mallory, alice, withBob, "thread.received", { ids: [e.id] }))), /not a participant/);
  assert.equal((await alice.receive(await craft(mallory, alice, withMallory, "thread.received", { ids: [e.id] }))).result, "control");
  assert.match(reason(await alice.receive(await craft(await person(), alice, withBob, "thread.received", { ids: [e.id] }))), /unknown sender/);
  assert.equal(alice.delivery(e.id), "stored");
});

test("a database made before receipts existed is upgraded in place", async () => {
  const { alice, bob } = await paired();
  const thread = await alice.openThread("bob", "old db");
  const e = await alice.say(thread, "hello");
  alice.close();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(alice.home, "state.db"));
  db.exec("ALTER TABLE outbox DROP COLUMN received_at; ALTER TABLE outbox DROP COLUMN resends; DROP TABLE receipts_due; DROP TABLE resend_asked; DROP TABLE resend_served");
  db.close();
  const again = Counterpart.open(alice.home, { now });
  assert.equal(again.delivery(e.id), "queued");
  await carry(again, bob);
  assert.deepEqual(texts(bob, thread), ["hello"]);
  again.close();
});

test("through a real relay: receipts arrive on their own and a request is sent without being asked", async () => {
  const [alice, bob] = [await person({ real: true, receiptDelayMs: 50 }), await person({ real: true, receiptDelayMs: 50, resendAfterMs: 100 })];
  for (const n of [alice, bob]) {
    const l = new RelayLink(n, { pollMs: 20 }).start();
    stops.push(() => l.stop());
  }
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await until("pairing", () => bob.contacts()[0]?.state === "active" && alice.contacts()[0]?.state === "active");
  const thread = await alice.openThread("bob", "live");
  const e = await alice.say(thread, "hello");
  await until("the receipt", () => alice.delivery(e.id) === "received");
  await until("relay mailbox drains", () => relay.queued() === 0);

  // Make Bob forget an event, as if it had never been delivered, then send one that depends on it.
  const gone = await alice.say(thread, "this one goes missing");
  await until("bob has it", () => texts(bob, thread).length === 2);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(bob.home, "state.db"));
  db.prepare("DELETE FROM events WHERE id = ?").run(gone.id);
  db.close();
  const next = await alice.say(thread, "after the gap");
  await until("bob recovers through a resend", () => texts(bob, thread).length === 3);
  assert.deepEqual(texts(bob, thread), ["hello", "this one goes missing", "after the gap"]);
  await until("the last receipt", () => alice.delivery(next.id) === "received");
});
