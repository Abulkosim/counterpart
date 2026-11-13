import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Evidence, partDigest } from "@counterpart/protocol";
import { Counterpart, shippedVerifierHash } from "../src/index.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PASS = "a-passphrase";
const SCHEMA = '{"type":"object","required":["data"]}';
async function person(): Promise<Counterpart> {
  const home = mkdtempSync(join(tmpdir(), "cpart-ev-"));
  dirs.push(home);
  return Counterpart.init(home, { relay: "ws://127.0.0.1:1", passphrase: PASS, logN: 14 });
}
// Hand over everything queued, both ways, until nothing is left.
async function sync(a: Counterpart, b: Counterpart): Promise<void> {
  for (let moved = true; moved; ) {
    moved = false;
    for (const [from, to] of [[a, b], [b, a]] as const) {
      for (const wire of from.queued()) {
        await to.receive(wire);
        from.markOutbox(wire.header.id, "stored");
        moved = true;
      }
    }
  }
}
async function scene() {
  const [alice, bob] = [await person(), await person()];
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await sync(alice, bob);
  const thread = await alice.openThread("bob", "orders");
  const p = await alice.propose(thread, { title: "Orders page", text: "Follows the schema.", parts: [{ kind: "json-schema", name: "page.schema.json", content: SCHEMA }, { kind: "text", name: "notes.md", content: "notes" }] });
  await sync(alice, bob);
  const evidence = (over: Partial<Evidence> = {}): Evidence => ({
    v: 1, proposalId: p.proposalId, contractHash: p.hash, repo: "alice/orders-api", head: "a".repeat(40), base: "b".repeat(40),
    bindingsHash: "c".repeat(64), trustPolicyHash: "d".repeat(64), verifier: { version: "1", sha256: shippedVerifierHash() },
    parts: [{ part: "page.schema.json", path: "schemas/page.schema.json", sha256: partDigest(SCHEMA), ok: true }],
    ...over,
  });
  const agree = async (): Promise<void> => {
    await alice.approve(thread, p.proposalId, p.hash, PASS);
    await sync(alice, bob);
    await bob.approve(thread, p.proposalId, p.hash, PASS);
    await sync(alice, bob);
  };
  return { alice, bob, thread, p, evidence, agree };
}

test("evidence cannot be sent or received before both people signed", async () => {
  const { alice, bob, thread, evidence } = await scene();
  await assert.rejects(alice.postEvidence(thread, evidence()), /not agreed/);
  await alice.approve(thread, evidence().proposalId, evidence().contractHash, PASS);
  await assert.rejects(alice.postEvidence(thread, evidence()), /not agreed/);
  assert.deepEqual(alice.evidence(thread), []);
  await sync(alice, bob);
  await bob.approve(thread, evidence().proposalId, evidence().contractHash, PASS);
  await sync(alice, bob);
  await assert.rejects(alice.postEvidence(thread, evidence({ contractHash: "A".repeat(43) })), /different contract/);
  await assert.rejects(alice.postEvidence(thread, evidence({ proposalId: "A".repeat(22) })), /has not seen/);
  await assert.rejects(alice.postEvidence(thread, { ...evidence(), repo: "not a label" }), /repo label/);
  await alice.postEvidence(thread, evidence());
  await sync(alice, bob);
  assert.equal(bob.evidence(thread).length, 1);
  assert.equal(bob.rejects().length, 0);
});

test("the receiver marks as checked only what it recomputed, and both sides see the same evidence", async () => {
  const { alice, bob, thread, p, evidence, agree } = await scene();
  await agree();
  const sent = await alice.postEvidence(thread, evidence({ pr: "https://github.com/alice/orders-api/pull/7", run: { url: "https://github.com/alice/orders-api/actions/runs/9", status: "success" } }));
  await sync(alice, bob);
  const [theirs] = bob.evidence(thread, p.proposalId);
  assert.equal(theirs!.eventId, sent.id);
  assert.equal(theirs!.mine, false);
  assert.equal(theirs!.state, "current");
  assert.deepEqual(theirs!.checked, {
    agreed: true, verifier: "same", unreported: ["notes.md"], partsMatch: true,
    parts: [{ part: "page.schema.json", path: "schemas/page.schema.json", sha256: partDigest(SCHEMA), signedSha256: partDigest(SCHEMA), claimedOk: true, check: "match" }],
  });
  assert.equal(theirs!.claim.run!.status, "success");
  const [mine] = alice.evidence(thread);
  assert.equal(mine!.mine, true);
  assert.deepEqual(mine!.claim, theirs!.claim);
  assert.deepEqual(bob.evidence(thread, "A".repeat(22)), []);
  assert.equal(bob.log(thread).at(-1)!.type, "evidence.posted");
});

test("a wrong digest or an unknown verifier shows as such whatever the sender claims", async () => {
  const { alice, bob, thread, evidence, agree } = await scene();
  await agree();
  await alice.postEvidence(thread, evidence({ verifier: { version: "1", sha256: "e".repeat(64) }, parts: [{ part: "page.schema.json", path: "schemas/page.schema.json", sha256: partDigest(`${SCHEMA}\n`), ok: true }, { part: "notes.md", path: "notes.md", ok: false }] }));
  await sync(alice, bob);
  const [v] = bob.evidence(thread);
  assert.deepEqual(v!.checked.parts.map((x) => [x.check, x.claimedOk]), [["mismatch", true], ["missing", false]]);
  assert.equal(v!.checked.partsMatch, false);
  assert.equal(v!.checked.verifier, "different");
  assert.deepEqual(v!.checked.unreported, []);
});

test("newer evidence from the same side makes older evidence stale or replaced, per side and per proposal", async () => {
  const { alice, bob, thread, evidence, agree } = await scene();
  await agree();
  await alice.postEvidence(thread, evidence());
  await bob.postEvidence(thread, evidence({ repo: "bob/orders-client", head: "9".repeat(40) }));
  await alice.postEvidence(thread, evidence({ run: { url: "https://ci.example.com/1", status: "success" } }));
  await alice.postEvidence(thread, evidence({ head: "e".repeat(40), bindingsHash: "0".repeat(64) }));
  await sync(alice, bob);
  for (const who of [alice, bob]) {
    const list = who.evidence(thread);
    const from = (mine: boolean) => list.filter((v) => v.mine === mine).map((v) => [v.state, v.changed.join()]);
    assert.deepEqual(from(who === alice), [["stale", "head,bindings"], ["stale", "head,bindings"], ["current", ""]]);
    assert.deepEqual(from(who !== alice), [["current", ""]]);
  }
  await alice.postEvidence(thread, evidence({ head: "e".repeat(40), bindingsHash: "0".repeat(64), base: "7".repeat(40), trustPolicyHash: "8".repeat(64) }));
  assert.deepEqual(alice.evidence(thread).filter((v) => v.mine).map((v) => v.changed.join()), ["head,base,bindings,policy", "head,base,bindings,policy", "base,policy", ""]);
});

test("stored evidence is parsed again when read, so an edited database cannot show a link that was never accepted", async () => {
  const { alice, bob, thread, evidence, agree } = await scene();
  await agree();
  await alice.postEvidence(thread, evidence());
  await sync(alice, bob);
  const db = new DatabaseSync(join(bob.home, "state.db"));
  db.prepare("UPDATE evidence SET json = ?").run(JSON.stringify({ ...evidence(), pr: "javascript:alert(1)" }));
  db.close();
  assert.throws(() => bob.evidence(thread), /evidence: pull request URL/);
});
