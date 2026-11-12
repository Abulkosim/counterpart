import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const sync = (who: Counterpart, thread: string, n: number) => until(`${n} contracts`, () => who.contracts(thread).length === n);
function craft<T extends EventType>(from: Counterpart, to: Counterpart, threadId: string, type: T, body: EventBodies[T], parents: string[] = []): Promise<Wire> {
  const seq = from.log(threadId).filter((e) => e.mine).length + 50 + Math.floor(Math.random() * 1e6);
  const event = { id: randomId(), threadId, author: from.me.device, authorSeq: seq, parents, lane: laneOf(type), type, body, createdAt: Date.now() } as ThreadEvent;
  return seal(event, from.device, to.device.credential, Date.now() + 3600_000);
}

test("two people propose, revise, approve the same text, and export an agreement anyone can check", async () => {
  const { alice, bob, thread } = await scene();
  const first = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  assert.equal(bob.contracts(thread)[0]!.status, "open");
  assert.equal(bob.contracts(thread)[0]!.proposedByMe, false);

  const second = await bob.propose(thread, { ...DRAFT, text: DRAFT.text.replace("100", "200") }, { supersedes: first.hash });
  await sync(alice, thread, 2);
  assert.equal(alice.contracts(thread).find((c) => c.hash === first.hash)!.status, "superseded");

  await alice.approve(thread, second.hash, PASS.alice);
  await until("bob sees alice's approval", () => bob.contracts(thread).find((c) => c.hash === second.hash)!.approvedByThem);
  assert.equal(bob.contracts(thread).find((c) => c.hash === second.hash)!.status, "open");
  assert.throws(() => bob.agreement(thread, second.hash), /not agreed yet/);

  await bob.approve(thread, second.hash, PASS.bob);
  await until("alice sees agreement", () => alice.contracts(thread).find((c) => c.hash === second.hash)!.status === "agreed");
  const [fromAlice, fromBob] = [alice.agreement(thread, second.hash), bob.agreement(thread, second.hash)];
  assert.deepEqual(fromAlice, fromBob, "both sides hold the same agreement");
  const checked = verifyAgreement(JSON.parse(JSON.stringify(fromAlice)));
  assert.deepEqual(checked.contract.parties, [alice.me.rootKey, bob.me.rootKey].sort());
  assert.match(checked.contract.text, /200/);
});

test("an agreement file with one byte changed, a swapped signer or a missing approval does not verify", async () => {
  const { alice, bob, thread } = await scene();
  const { hash } = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  await alice.approve(thread, hash, PASS.alice);
  await bob.approve(thread, hash, PASS.bob);
  await until("agreed", () => alice.contracts(thread)[0]!.status === "agreed");
  const good = alice.agreement(thread, hash);
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
  forged.approvals[1] = signApproval(mallory, { threadGenesis: good.threadGenesis, proposalId: good.approvals[1]!.proposalId, contractHash: hash, parties: good.contract.parties, approvedAt: 1 });
  assert.throws(() => verifyAgreement(forged), /not a party/);
  const flipped = copy();
  flipped.approvals[0]!.approvedAt += 1;
  assert.throws(() => verifyAgreement(flipped), /bad signature/);
});

test("approval needs the passphrase; a process that can read the key file cannot approve", async () => {
  const { alice, bob, thread } = await scene();
  const { hash } = await bob.propose(thread, DRAFT);
  await sync(alice, thread, 1);
  await assert.rejects(alice.approve(thread, hash, "guess-guess"), /wrong passphrase/);
  assert.equal(alice.contracts(thread)[0]!.approvedByMe, false);
  const file = JSON.parse(readFileSync(join(alice.home, "keys.json"), "utf8")) as Record<string, unknown>;
  assert.equal(file.root, undefined, "no usable root secret on disk");
  assert.ok(!JSON.stringify(file).includes(PASS.alice));

  const open = await person();
  await pairUp(open, bob, "bob", "open");
  const t2 = await bob.openThread("open", "x");
  await until("thread", () => open.threads().length === 1);
  const p2 = await bob.propose(t2, DRAFT);
  await sync(open, t2, 1);
  await assert.rejects(open.approve(t2, p2.hash, "anything"), /no passphrase/);
  open.protect("now-protected", 14);
  await open.approve(t2, p2.hash, "now-protected");
  await until("bob sees it", () => bob.contracts(t2)[0]!.approvedByThem);
});

test("a forged, borrowed or misplaced approval from the other side is refused", async () => {
  const { alice, bob, thread } = await scene();
  const carol = await person(PASS.alice);
  await pairUp(carol, bob, "bob", "carol");
  const { hash, event } = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  const genesis = bob.agreementContext(thread).genesis;
  const parties = [alice.me.rootKey, bob.me.rootKey].sort();
  const fields = { threadGenesis: genesis, proposalId: event.id, contractHash: hash, parties, approvedAt: Date.now() };
  const reasons: string[] = [];
  const send = async (from: Counterpart, approval: Approval, parents = [event.id]): Promise<void> => {
    const v = await bob.receive(await craft(from, bob, thread, "contract.accepted", { approval }, parents));
    assert.equal(v.result, "rejected");
    if (v.result === "rejected") reasons.push(v.reason);
  };
  const stranger = generateSigningKey();
  // Alice's device sends an approval signed by some other key.
  const borrowed = signApproval(stranger, { ...fields, parties: [stranger.publicKey, bob.me.rootKey].sort() });
  await send(alice, borrowed);
  // Carol, another contact of Bob's, tries to approve in Alice's thread.
  await send(carol, borrowed);
  // An honest client will not even build an approval whose signer is not a party.
  await assert.rejects(craft(alice, bob, thread, "contract.accepted", { approval: signApproval(stranger, fields) }, [event.id]), /contract\.accepted/);
  assert.equal(bob.contracts(thread)[0]!.approvedByThem, false);
  assert.ok(reasons.every((r) => /not signed by the person|not a participant|shape|body/.test(r)), reasons.join(" | "));
});

test("an approval cannot be replayed into another thread or onto another contract", async () => {
  const { alice, bob, thread } = await scene();
  const { hash } = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  await alice.approve(thread, hash, PASS.alice);
  await until("approved", () => bob.contracts(thread)[0]!.approvedByThem);
  const real = (alice.log(thread).find((e) => e.type === "contract.accepted")!.body as { approval: Approval }).approval;

  // Same contract text proposed in a second thread: Alice's old signature must not count there.
  const t2 = await alice.openThread("bob", "second thread");
  await until("t2", () => bob.threads().length === 2);
  const again = await alice.propose(t2, DRAFT);
  assert.equal(again.hash, hash);
  await sync(bob, t2, 1);
  const v1 = await bob.receive(await craft(alice, bob, t2, "contract.accepted", { approval: real }, [again.event.id]));
  assert.equal(v1.result === "rejected" && v1.reason, "approval belongs to a different thread");

  // A different contract in the first thread.
  const other = await alice.propose(thread, { ...DRAFT, text: "Bob pays Alice 100." });
  await sync(bob, thread, 2);
  const v2 = await bob.receive(await craft(alice, bob, thread, "contract.accepted", { approval: real }, [other.event.id]));
  assert.equal(v2.result === "rejected" && v2.reason, "acceptance must refer to the proposal it accepts");
  const v3 = await bob.receive(await craft(alice, bob, thread, "contract.accepted", { approval: real }, [other.event.id, real.proposalId]));
  assert.equal(v3.result === "rejected" && v3.reason, "this person already approved this contract");
  assert.equal(bob.contracts(thread).find((c) => c.hash === other.hash)!.approvedByThem, false);
  assert.equal(bob.contracts(t2)[0]!.approvedByThem, false);
});

test("decline and withdraw are recorded; only the proposer can withdraw; an approval given before a withdrawal stands", async () => {
  const { alice, bob, thread } = await scene();
  const a = await alice.propose(thread, DRAFT);
  await sync(bob, thread, 1);
  await assert.rejects(bob.withdraw(thread, a.hash), /only the proposer/);
  await bob.decline(thread, a.hash, "page size too small <b>");
  await until("alice sees decline", () => alice.contracts(thread)[0]!.status === "declined");
  assert.deepEqual(alice.contracts(thread)[0]!.declinedBy, ["them"]);
  assert.equal(alice.contracts(thread)[0]!.declineReason, "page size too small <b>");

  const b = await alice.propose(thread, { ...DRAFT, text: "v2" });
  await sync(bob, thread, 2);
  await bob.approve(thread, b.hash, PASS.bob);
  await alice.withdraw(thread, b.hash);
  await until("bob sees withdrawal", () => bob.contracts(thread).find((c) => c.hash === b.hash)!.withdrawn);
  assert.equal(bob.contracts(thread).find((c) => c.hash === b.hash)!.status, "withdrawn");
  assert.equal(bob.contracts(thread).find((c) => c.hash === b.hash)!.approvedByMe, true);
  // Withdrawal stops asking; it does not cancel a signature. If Alice signs after all, it is agreed.
  await alice.approve(thread, b.hash, PASS.alice);
  await until("agreed", () => bob.contracts(thread).find((c) => c.hash === b.hash)!.status === "agreed");
});

test("the other side cannot flood proposals, name outsiders as parties, or act on contracts the thread has not seen", async () => {
  const { alice, bob, thread } = await scene();
  const outsider = generateSigningKey().publicKey;
  const base = { v: 1 as const, title: "t", text: "x", parts: [] };
  const wrongParties = await bob.receive(await craft(alice, bob, thread, "contract.proposed", { contract: { ...base, parties: [alice.me.rootKey, outsider].sort() } }));
  assert.equal(wrongParties.result === "rejected" && wrongParties.reason, "contract parties must be exactly the two people in this thread");
  const ghost = contractHash({ ...base, parties: [alice.me.rootKey, bob.me.rootKey].sort() });
  for (const [type, body] of [["contract.declined", { contractHash: ghost }], ["contract.withdrawn", { contractHash: ghost }]] as const) {
    assert.equal((await bob.receive(await craft(alice, bob, thread, type, body))).result, "rejected");
  }
  for (let i = 0; i < 20; i++) await alice.propose(thread, { title: "t", text: `draft ${i}` });
  await assert.rejects(alice.propose(thread, { title: "t", text: "one too many" }), /at most 20/);
  await sync(bob, thread, 20);
  const extra = await bob.receive(await craft(alice, bob, thread, "contract.proposed", { contract: { ...base, text: "21st", parties: [alice.me.rootKey, bob.me.rootKey].sort() } }));
  assert.equal(extra.result === "rejected" && extra.reason, "a side may make at most 20 proposals in a thread");
  assert.equal(bob.contracts(thread).length, 20);
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
