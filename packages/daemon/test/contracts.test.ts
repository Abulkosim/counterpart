import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Approval, type EventBodies, type EventType, type ThreadEvent, type Wire, contractHash, generateSigningKey, laneOf, randomId, seal,
  signApproval, verifyAgreement,
} from "@counterpart/protocol";
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

const PASS = { alice: "alice-passphrase", bob: "bob-passphrase" };
async function person(passphrase?: string): Promise<Counterpart> {
  const home = mkdtempSync(join(tmpdir(), "cpart-c-"));
  dirs.push(home);
  const node = await Counterpart.init(home, { relay: relay.url, ...(passphrase ? { passphrase, logN: 14 } : {}) });
  links.push(new RelayLink(node, { pollMs: 20 }).start());
  return node;
}
async function until(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function pairUp(a: Counterpart, b: Counterpart, aCallsB: string, bCallsA: string): Promise<void> {
  await b.acceptInvite(a.createInvite(aCallsB), bCallsA);
  await until("pairing", () => a.contacts().some((c) => c.name === aCallsB && c.state === "active") && b.contacts().some((c) => c.name === bCallsA && c.state === "active"));
}
async function scene() {
  const [alice, bob] = [await person(PASS.alice), await person(PASS.bob)];
  await pairUp(alice, bob, "bob", "alice");
  const thread = await alice.openThread("bob", "agree on pagination");
  await until("thread reaches bob", () => bob.threads().length === 1);
  return { alice, bob, thread };
}
const DRAFT = { title: "Orders pagination", text: "GET /v2/orders uses an opaque cursor. Max page size 100.", parts: [{ kind: "json-schema" as const, name: "page.schema.json", content: '{"type":"object","required":["data","next_cursor"]}' }] };
const sync = (who: Counterpart, thread: string, n: number) => until(`${n} proposals`, () => who.contracts(thread).length === n);
const view = (who: Counterpart, thread: string, proposalId: string) => who.contracts(thread).find((c) => c.proposalId === proposalId)!;
function craft<T extends EventType>(from: Counterpart, to: Counterpart, threadId: string, type: T, body: EventBodies[T], parents: string[] = []): Promise<Wire> {
  const seq = from.log(threadId).filter((e) => e.mine).length + 50 + Math.floor(Math.random() * 1e6);
  const event = { id: randomId(), threadId, author: from.me.device, authorSeq: seq, parents, lane: laneOf(type), type, body, createdAt: Date.now() } as ThreadEvent;
  return seal(event, from.device, to.device.credential, Date.now() + 3600_000);
}

test("two people propose, revise, approve the same proposal, and export an agreement anyone can check", async () => {
  const { alice, bob, thread } = await scene();
  const first = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  assert.equal(view(bob, thread, first.proposalId).status, "open");
  assert.equal(view(bob, thread, first.proposalId).proposedByMe, false);

  const second = await bob.propose(thread, { ...DRAFT, text: DRAFT.text.replace("100", "200") }, { supersedes: first.proposalId });
  await sync(alice, thread, 2);
  assert.equal(view(alice, thread, first.proposalId).status, "superseded");

  await alice.approve(thread, second.proposalId, second.hash, PASS.alice);
  await until("bob sees alice's approval", () => view(bob, thread, second.proposalId).approvedByThem);
  assert.equal(view(bob, thread, second.proposalId).status, "open");
  assert.throws(() => bob.agreement(thread, second.proposalId), /not agreed yet/);

  await bob.approve(thread, second.proposalId, second.hash, PASS.bob);
  await until("alice sees agreement", () => view(alice, thread, second.proposalId).status === "agreed");
  const [fromAlice, fromBob] = [alice.agreement(thread, second.proposalId), bob.agreement(thread, second.proposalId)];
  assert.deepEqual(fromAlice, fromBob, "both sides hold the same agreement");
  const checked = verifyAgreement(JSON.parse(JSON.stringify(fromAlice)));
  assert.deepEqual(checked.contract.parties, [alice.me.rootKey, bob.me.rootKey].sort());
  assert.match(checked.contract.text, /200/);
});

test("an agreement file that was edited, re-signed by an outsider, one-sided or moved to another thread does not verify", async () => {
  const { alice, bob, thread } = await scene();
  const p = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  await alice.approve(thread, p.proposalId, p.hash, PASS.alice);
  await bob.approve(thread, p.proposalId, p.hash, PASS.bob);
  await until("agreed", () => view(alice, thread, p.proposalId).status === "agreed");
  const good = alice.agreement(thread, p.proposalId);
  const copy = () => JSON.parse(JSON.stringify(good)) as typeof good;

  const edited = copy();
  edited.contract.text = edited.contract.text.replace("100", "101");
  assert.throws(() => verifyAgreement(edited), /does not match its hash/);
  const rehashed = copy();
  rehashed.contract.text = rehashed.contract.text.replace("100", "101");
  rehashed.contractHash = contractHash(rehashed.contract);
  assert.throws(() => verifyAgreement(rehashed), /different contract/);
  const oneSided = copy();
  oneSided.approvals = [oneSided.approvals[0]!, oneSided.approvals[0]!];
  assert.throws(() => verifyAgreement(oneSided), /two parties/);
  const mallory = generateSigningKey();
  const forged = copy();
  forged.approvals[1] = signApproval(mallory, { threadGenesis: good.approvals[1]!.threadGenesis, proposalId: p.proposalId, contractHash: p.hash, parties: good.contract.parties, approvedAt: 1 });
  assert.throws(() => verifyAgreement(forged), /not a party/);
  const flipped = copy();
  flipped.approvals[0]!.approvedAt += 1;
  assert.throws(() => verifyAgreement(flipped), /bad signature/);
  // The thread's first event is part of the file, so the thread cannot be swapped for another.
  const moved = copy();
  moved.genesis.threadId = randomId();
  assert.throws(() => verifyAgreement(moved), /different thread/);
  const regoal = copy();
  (regoal.genesis.body as { goal: string }).goal = "something else entirely";
  assert.throws(() => verifyAgreement(regoal), /different thread/);
  const otherProposal = copy();
  otherProposal.proposalId = randomId();
  assert.throws(() => verifyAgreement(otherProposal), /different proposal/);
});

test("approval needs the passphrase; reading the key file is not enough; an identity made without one can never approve", async () => {
  const { alice, bob, thread } = await scene();
  const p = await bob.propose(thread, DRAFT);
  await sync(alice, thread, 1);
  await assert.rejects(alice.approve(thread, p.proposalId, p.hash, "guess-guess"), /wrong passphrase/);
  assert.equal(view(alice, thread, p.proposalId).approvedByMe, false);
  const file = JSON.parse(readFileSync(join(alice.home, "keys.json"), "utf8")) as Record<string, unknown>;
  assert.equal(file.root, undefined, "no usable root secret on disk");
  assert.ok(!JSON.stringify(file).includes(PASS.alice));

  const open = await person();
  await pairUp(open, bob, "bob", "open");
  const t2 = await bob.openThread("open", "x");
  await until("thread", () => open.threads().length === 1);
  const p2 = await bob.propose(t2, DRAFT);
  await sync(open, t2, 1);
  await assert.rejects(open.approve(t2, p2.proposalId, p2.hash, "anything"), /made without a passphrase/);
  assert.equal(typeof (open as unknown as { protect?: unknown }).protect, "undefined", "there is no way to lock a root key that has already been exposed");
});

test("the same text proposed twice is two proposals; approvals of different ones do not add up", async () => {
  const { alice, bob, thread } = await scene();
  const p1 = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  const p2 = await bob.propose(thread, DRAFT);
  await sync(alice, thread, 2);
  assert.equal(p1.hash, p2.hash);
  assert.notEqual(p1.proposalId, p2.proposalId);
  await alice.approve(thread, p1.proposalId, p1.hash, PASS.alice);
  await bob.approve(thread, p2.proposalId, p2.hash, PASS.bob);
  await until("both approvals arrive", () => view(alice, thread, p2.proposalId).approvedByThem && view(bob, thread, p1.proposalId).approvedByThem);
  for (const who of [alice, bob]) {
    assert.equal(view(who, thread, p1.proposalId).status, "open");
    assert.equal(view(who, thread, p2.proposalId).status, "open");
    assert.throws(() => who.agreement(thread, p1.proposalId), /not agreed yet/);
    assert.throws(() => who.agreement(thread, p2.proposalId), /not agreed yet/);
  }
  // Declining one leaves the other untouched.
  await bob.decline(thread, p1.proposalId);
  await until("decline arrives", () => view(alice, thread, p1.proposalId).status === "declined");
  assert.equal(view(alice, thread, p2.proposalId).status, "open");
});

test("if the stored text is swapped after the owner looked, nothing is signed", async () => {
  const { alice, bob, thread } = await scene();
  const p = await bob.propose(thread, DRAFT);
  await sync(alice, thread, 1);
  const shown = view(alice, thread, p.proposalId);
  // Another program running as Alice rewrites her database: benign text shown, malicious hash kept.
  const db = new DatabaseSync(join(alice.home, "state.db"));
  const evil = { ...shown.contract, text: "Alice gives Bob everything." };
  db.prepare("UPDATE proposals SET contract = ? WHERE event_id = ?").run(JSON.stringify(evil), p.proposalId);
  db.close();
  assert.throws(() => alice.contracts(thread), /database has been altered/);
  await assert.rejects(alice.approve(thread, p.proposalId, shown.hash, PASS.alice), /altered/);
  // Consistently replacing text and hash is caught by comparing with what was shown.
  const db2 = new DatabaseSync(join(alice.home, "state.db"));
  db2.prepare("UPDATE proposals SET contract = ?, contract_hash = ? WHERE event_id = ?").run(JSON.stringify(evil), contractHash(evil), p.proposalId);
  db2.close();
  await assert.rejects(alice.approve(thread, p.proposalId, shown.hash, PASS.alice), /not the text you were shown/);
  assert.equal(alice.log(thread).filter((e) => e.type === "contract.accepted").length, 0);
});

test("a forged or borrowed approval from the other side is refused", async () => {
  const { alice, bob, thread } = await scene();
  const carol = await person(PASS.alice);
  await pairUp(carol, bob, "bob", "carol");
  const p = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  const ctx = bob.agreementContext(thread);
  const fields = { threadGenesis: ctx.genesis, proposalId: p.proposalId, contractHash: p.hash, parties: ctx.parties, approvedAt: Date.now() };
  const stranger = generateSigningKey();
  const borrowed = signApproval(stranger, { ...fields, parties: [stranger.publicKey, bob.me.rootKey].sort() });
  for (const from of [alice, carol]) {
    const v = await bob.receive(await craft(from, bob, thread, "contract.accepted", { approval: borrowed }, [p.proposalId]));
    assert.equal(v.result, "rejected");
  }
  // An honest client will not even build an approval whose signer is not a party.
  await assert.rejects(craft(alice, bob, thread, "contract.accepted", { approval: signApproval(stranger, fields) }, [p.proposalId]), /contract\.accepted/);
  assert.equal(view(bob, thread, p.proposalId).approvedByThem, false);
});

test("an approval cannot be replayed into another thread or onto another proposal", async () => {
  const { alice, bob, thread } = await scene();
  const p = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  await alice.approve(thread, p.proposalId, p.hash, PASS.alice);
  await until("approved", () => view(bob, thread, p.proposalId).approvedByThem);
  const real = (alice.log(thread).find((e) => e.type === "contract.accepted")!.body as { approval: Approval }).approval;

  const t2 = await alice.openThread("bob", "second thread");
  await until("t2", () => bob.threads().length === 2);
  const again = await alice.propose(t2, DRAFT);
  assert.equal(again.hash, p.hash);
  await sync(bob, t2, 1);
  const v1 = await bob.receive(await craft(alice, bob, t2, "contract.accepted", { approval: real }, [again.proposalId]));
  assert.equal(v1.result === "rejected" && v1.reason, "approval belongs to a different thread");

  const other = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 2);
  const v2 = await bob.receive(await craft(alice, bob, thread, "contract.accepted", { approval: real }, [other.proposalId]));
  assert.equal(v2.result === "rejected" && v2.reason, "acceptance must refer to the proposal it accepts");
  const v3 = await bob.receive(await craft(alice, bob, thread, "contract.accepted", { approval: real }, [other.proposalId, real.proposalId]));
  assert.equal(v3.result === "rejected" && v3.reason, "this person already approved this proposal");
  assert.equal(view(bob, thread, other.proposalId).approvedByThem, false);
  assert.equal(view(bob, t2, again.proposalId).approvedByThem, false);
});

test("decline and withdraw are recorded; only the proposer can withdraw; an approval given before a withdrawal stands", async () => {
  const { alice, bob, thread } = await scene();
  const a = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  await assert.rejects(bob.withdraw(thread, a.proposalId), /only the proposer/);
  await bob.decline(thread, a.proposalId, "page size too small <b>");
  await until("alice sees decline", () => view(alice, thread, a.proposalId).status === "declined");
  assert.deepEqual(view(alice, thread, a.proposalId).declinedBy, ["them"]);
  assert.equal(view(alice, thread, a.proposalId).declineReason, "page size too small <b>");

  const b = await alice.propose(thread, { ...DRAFT, text: "v2" });
  await sync(bob, thread, 2);
  await bob.approve(thread, b.proposalId, b.hash, PASS.bob);
  await alice.withdraw(thread, b.proposalId);
  await until("bob sees withdrawal", () => view(bob, thread, b.proposalId).withdrawn);
  assert.equal(view(bob, thread, b.proposalId).status, "withdrawn");
  assert.equal(view(bob, thread, b.proposalId).approvedByMe, true);
  // Withdrawal stops asking; it does not cancel a signature. If Alice signs after all, it is agreed.
  await alice.approve(thread, b.proposalId, b.hash, PASS.alice);
  await until("agreed", () => view(bob, thread, b.proposalId).status === "agreed");
});

test("the other side cannot flood proposals, name outsiders as parties, or act on proposals the thread has not seen", async () => {
  const { alice, bob, thread } = await scene();
  const outsider = generateSigningKey().publicKey;
  const base = { v: 1 as const, title: "t", text: "x", parts: [] };
  const wrongParties = await bob.receive(await craft(alice, bob, thread, "contract.proposed", { contract: { ...base, parties: [alice.me.rootKey, outsider].sort() } }));
  assert.equal(wrongParties.result === "rejected" && wrongParties.reason, "contract parties must be exactly the two people in this thread");
  const ghost = randomId();
  assert.equal((await bob.receive(await craft(alice, bob, thread, "contract.declined", { proposalId: ghost }))).result, "rejected");
  assert.equal((await bob.receive(await craft(alice, bob, thread, "contract.withdrawn", { proposalId: ghost }))).result, "rejected");
  // Bob's own proposal cannot be withdrawn by Alice.
  const bobs = await bob.propose(thread, { title: "t", text: "bob's" });
  const theft = await bob.receive(await craft(alice, bob, thread, "contract.withdrawn", { proposalId: bobs.proposalId }));
  assert.equal(theft.result === "rejected" && theft.reason, "only the proposer can withdraw a proposal");
  for (let i = 0; i < 20; i++) await alice.propose(thread, { title: "t", text: `draft ${i}` });
  await assert.rejects(alice.propose(thread, { title: "t", text: "one too many" }), /at most 20/);
  await sync(bob, thread, 21);
  const extra = await bob.receive(await craft(alice, bob, thread, "contract.proposed", { contract: { ...base, text: "21st", parties: [alice.me.rootKey, bob.me.rootKey].sort() } }));
  assert.equal(extra.result === "rejected" && extra.reason, "a side may make at most 20 proposals in a thread");
  assert.equal(bob.contracts(thread).length, 21);
});

test("a locked identity does not renew unattended, and renews with the passphrase", async () => {
  const home = mkdtempSync(join(tmpdir(), "cpart-c-"));
  dirs.push(home);
  const day = 24 * 3600_000;
  let t = Date.now();
  const node = await Counterpart.init(home, { relay: relay.url, passphrase: "a-long-passphrase", logN: 14, now: () => t });
  const first = node.credentialExpiresAt;
  t += 70 * day;
  assert.equal(await node.renewIfDue(), false);
  assert.equal(node.credentialExpiresAt, first);
  await assert.rejects(node.renew("wrong-passphrase"), /wrong passphrase/);
  await node.renew("a-long-passphrase");
  assert.ok(node.credentialExpiresAt > first);
  node.close();
});
