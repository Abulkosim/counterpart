import assert from "node:assert/strict";
import { type Counterpart, shippedVerifierHash } from "@counterpart/daemon";
import { type Evidence, EVIDENCE_LIMITS, partDigest } from "@counterpart/protocol";
import { type Ctx, event, forge, send } from "../harness.ts";
import type { Case } from "../types.ts";

const PASS = "gauntlet-passphrase";
const SCHEMA = '{"type":"object","required":["data","next_cursor"]}';
const WRONG = "f".repeat(64);

interface Scene {
  bob: Counterpart; // the one under attack
  alice: Counterpart; // the contact who sends evidence
  thread: string;
  proposalId: string;
  good: Evidence; // what an honest alice would send
}

async function propose(ctx: Ctx, from: Counterpart, to: Counterpart, thread: string): Promise<{ proposalId: string; hash: string }> {
  const p = await from.propose(thread, { title: "Orders page", text: "Follows the attached schema.", parts: [{ kind: "json-schema", name: "page.schema.json", content: SCHEMA }] });
  await ctx.carry(from, to);
  return p;
}

// Alice and Bob with one contract both have signed.
async function agreed(ctx: Ctx): Promise<Scene> {
  const bob = await ctx.person({ passphrase: PASS });
  const alice = await ctx.contact(bob, "alice", { passphrase: PASS });
  const thread = await ctx.thread(alice, "them", bob, "orders pagination");
  const p = await propose(ctx, alice, bob, thread);
  await alice.approve(thread, p.proposalId, p.hash, PASS);
  await ctx.carry(alice, bob);
  await bob.approve(thread, p.proposalId, p.hash, PASS);
  await ctx.carry(bob, alice);
  assert.equal(bob.contracts(thread)[0]!.status, "agreed");
  const good: Evidence = {
    v: 1, proposalId: p.proposalId, contractHash: p.hash, repo: "alice/orders-api", pr: "https://github.com/alice/orders-api/pull/7",
    head: "a".repeat(40), base: "b".repeat(40), bindingsHash: "c".repeat(64), trustPolicyHash: "d".repeat(64),
    verifier: { version: "1", sha256: shippedVerifierHash() },
    parts: [{ part: "page.schema.json", path: "schemas/page.schema.json", sha256: partDigest(SCHEMA), ok: true }],
    run: { url: "https://github.com/alice/orders-api/actions/runs/1", status: "success" },
  };
  return { bob, alice, thread, proposalId: p.proposalId, good };
}

// The next sequence number `to` expects from `from` in this thread.
const seq = (to: Counterpart, thread: string): number => to.log(thread).filter((e) => !e.mine).length;

// Evidence with any body at all, signed and sealed by its real author.
const raw = (from: Counterpart, to: Counterpart, thread: string, body: unknown): Promise<unknown> =>
  forge({ from, to, event: event(from, thread, "evidence.posted", body as Evidence, seq(to, thread)) });

export const evidence: Case[] = [
  {
    id: "EVD-01",
    category: "evidence",
    attacker: "contact",
    title: "Claim a part is fine while naming another file's digest",
    claim: "A digest that is not the signed part's is shown as a mismatch whatever the sender says about it, and what cannot be recomputed is never marked as checked.",
    async run(ctx) {
      const { bob, alice, thread, good } = await agreed(ctx);
      const lies: Evidence[] = [
        { ...good, parts: [{ ...good.parts[0]!, sha256: WRONG, ok: true }] },
        { ...good, parts: [{ part: "other.json", path: "schemas/page.schema.json", sha256: partDigest(SCHEMA), ok: true }] },
        { ...good, verifier: { version: "1", sha256: WRONG } },
      ];
      for (const lie of lies) assert.equal((await bob.receive(await send(alice, bob, event(alice, thread, "evidence.posted", lie, seq(bob, thread))))).result, "applied");
      const [digest, part, verifier] = bob.evidence(thread);
      assert.equal(digest!.checked.parts[0]!.check, "mismatch");
      assert.equal(digest!.checked.parts[0]!.claimedOk, true);
      assert.equal(digest!.checked.partsMatch, false);
      assert.equal(part!.checked.parts[0]!.check, "unknown-part");
      assert.equal(part!.checked.partsMatch, false);
      assert.deepEqual(part!.checked.unreported, ["page.schema.json"]);
      assert.equal(verifier!.checked.verifier, "different");
      // The honest one is the only one whose parts count as matching.
      assert.equal((await bob.receive(await send(alice, bob, event(alice, thread, "evidence.posted", good, seq(bob, thread))))).result, "applied");
      const honest = bob.evidence(thread).at(-1)!;
      assert.deepEqual([honest.checked.partsMatch, honest.checked.agreed, honest.checked.verifier, honest.state], [true, true, "same", "current"]);
      // Nothing in the view claims the commits, the repository or the run were checked.
      assert.deepEqual(Object.keys(honest.checked).sort(), ["agreed", "parts", "partsMatch", "unreported", "verifier"]);
    },
  },
  {
    id: "EVD-02",
    category: "evidence",
    attacker: "contact",
    title: "Send evidence for something nobody agreed",
    claim: "Evidence is accepted only for a proposal of this thread that both people signed, with that proposal's contract hash.",
    async run(ctx) {
      const { bob, alice, thread, good } = await agreed(ctx);
      const open = await propose(ctx, alice, bob, thread);
      const half = await propose(ctx, alice, bob, thread);
      await alice.approve(thread, half.proposalId, half.hash, PASS);
      await ctx.carry(alice, bob);
      const attempts: [string, Evidence][] = [
        ["an open proposal", { ...good, proposalId: open.proposalId, contractHash: open.hash }],
        ["a proposal only the sender signed", { ...good, proposalId: half.proposalId, contractHash: half.hash }],
        ["a proposal that does not exist", { ...good, proposalId: "A".repeat(22) }],
        ["the agreed proposal with another contract hash", { ...good, contractHash: "A".repeat(43) }],
        ["the thread id as the proposal", { ...good, proposalId: thread }],
      ];
      for (const [what, body] of attempts) await ctx.refused(bob, await send(alice, bob, event(alice, thread, "evidence.posted", body, seq(bob, thread))), what);
      assert.deepEqual(bob.evidence(thread), []);
    },
  },
  {
    id: "EVD-03",
    category: "evidence",
    attacker: "contact",
    title: "Put a script address, credentials or control characters in a link",
    claim: "An address in evidence is a short https URL in plain ASCII with no credentials, or the whole event is refused.",
    async run(ctx) {
      const { bob, alice, thread, good } = await agreed(ctx);
      const urls: unknown[] = [
        "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<script>alert(1)</script>", "http://github.com/a/b/pull/1", "file:///etc/passwd", "//evil.example/x",
        "https://user:pass@evil.example/", "https://token@evil.example/", "https://", "https:///nohost", "https://evil.example/\u001b[2J", "https://evil.example/‮gnp.exe",
        "https://evil.example/ onmouseover=alert(1)", "https://evil.example/\"><script>", "https://evil.example/\n[ok] verified", " https://evil.example/", "https://evil.example/\\..\\x",
        "https://еvil.example/", "", null, 7, ["https://evil.example/"], { href: "https://evil.example/" },
      ];
      for (const url of urls) {
        await ctx.refused(bob, await raw(alice, bob, thread, { ...good, pr: url }), `pr ${JSON.stringify(url)}`);
        await ctx.refused(bob, await raw(alice, bob, thread, { ...good, run: { url, status: "success" } }), `run ${JSON.stringify(url)}`);
      }
      for (const status of ["passed", "SUCCESS", "", true, null]) await ctx.refused(bob, await raw(alice, bob, thread, { ...good, run: { url: good.run!.url, status } }), `status ${JSON.stringify(status)}`);
      assert.deepEqual(bob.evidence(thread), []);
    },
  },
  {
    id: "EVD-04",
    category: "evidence",
    attacker: "contact",
    title: "Send oversized or misshapen evidence",
    claim: "Every field of evidence has a fixed shape and a length limit, and unknown fields are refused.",
    async run(ctx) {
      const { bob, alice, thread, good } = await agreed(ctx);
      const part = good.parts[0]!;
      const bodies: [string, unknown][] = [
        ["a long repo label", { ...good, repo: "a".repeat(EVIDENCE_LIMITS.repo + 1) }],
        ["a repo label with markup", { ...good, repo: "<img src=x onerror=alert(1)>" }],
        ["a repo label with an escape code", { ...good, repo: "alice/\u001b[31mapi" }],
        ["a repo label with a space", { ...good, repo: "alice/api verified" }],
        ["a long URL", { ...good, pr: `https://evil.example/${"a".repeat(EVIDENCE_LIMITS.url)}` }],
        ["too many parts", { ...good, parts: Array.from({ length: EVIDENCE_LIMITS.parts + 1 }, (_, i) => ({ ...part, path: `schemas/${i}.json` })) }],
        ["no parts", { ...good, parts: [] }],
        ["the same part twice", { ...good, parts: [part, part] }],
        ["a long path", { ...good, parts: [{ ...part, path: "a/".repeat(EVIDENCE_LIMITS.path) + "x" }] }],
        ["a path that climbs out", { ...good, parts: [{ ...part, path: "../../etc/passwd" }] }],
        ["an absolute path", { ...good, parts: [{ ...part, path: "/etc/passwd" }] }],
        ["a path with a control character", { ...good, parts: [{ ...part, path: "schemas/\u0007x.json" }] }],
        ["a path with a bidi override", { ...good, parts: [{ ...part, path: "schemas/‮nosj.x" }] }],
        ["a part name with a slash", { ...good, parts: [{ ...part, part: "../page.schema.json" }] }],
        ["a short digest", { ...good, parts: [{ ...part, sha256: "abc" }] }],
        ["an upper-case digest", { ...good, parts: [{ ...part, sha256: part.sha256!.toUpperCase() }] }],
        ["ok without a digest", { ...good, parts: [{ part: part.part, path: part.path, ok: true }] }],
        ["ok as a string", { ...good, parts: [{ ...part, ok: "true" }] }],
        ["an extra field in a part", { ...good, parts: [{ ...part, verified: true }] }],
        ["a short commit", { ...good, head: "abc1234" }],
        ["a branch name as a commit", { ...good, base: "main" }],
        ["a long verifier version", { ...good, verifier: { ...good.verifier, version: "9".repeat(EVIDENCE_LIMITS.version + 1) } }],
        ["a verifier version with markup", { ...good, verifier: { ...good.verifier, version: "<b>1</b>" } }],
        ["an extra field", { ...good, verified: true }],
        ["a checked field", { ...good, checked: { partsMatch: true } }],
        ["a missing field", (({ bindingsHash: _, ...rest }) => rest)(good)],
        ["another version", { ...good, v: 2 }],
        ["an array", [good]],
        ["a megabyte of padding", { ...good, note: "x".repeat(200_000) }],
      ];
      for (const [what, body] of bodies) await ctx.refused(bob, await raw(alice, bob, thread, body), what);
      assert.deepEqual(bob.evidence(thread), []);
    },
  },
  {
    id: "EVD-05",
    category: "evidence",
    attacker: "contact",
    title: "Flood a thread with evidence",
    claim: "A side can file a bounded number of pieces of evidence in a thread, and only the newest is current.",
    async run(ctx) {
      const { bob, alice, thread, good } = await agreed(ctx);
      // A hundred are kept. The next is refused and the newest kept one stays current.
      for (let i = 0; i < 100; i++) assert.equal((await bob.receive(await send(alice, bob, event(alice, thread, "evidence.posted", { ...good, head: i.toString(16).padStart(40, "0") }, seq(bob, thread))))).result, "applied");
      await ctx.refused(bob, await send(alice, bob, event(alice, thread, "evidence.posted", good, seq(bob, thread))), "evidence 101");
      const list = bob.evidence(thread);
      assert.equal(list.length, 100);
      assert.deepEqual(list.filter((v) => v.state === "current").map((v) => v.claim.head), [(99).toString(16).padStart(40, "0")]);
      assert.ok(list.slice(0, -1).every((v) => v.state === "stale" && v.changed.join() === "head"));
    },
  },
  {
    id: "EVD-06",
    category: "evidence",
    attacker: "contact",
    title: "File evidence about an agreement between two other people",
    claim: "Only the two people of a thread can add evidence to it, and evidence in one thread cannot cite an agreement made in another.",
    async run(ctx) {
      const { bob, alice, thread, good } = await agreed(ctx);
      const mallory = await ctx.contact(bob, "mallory", { passphrase: PASS });
      const hers = await ctx.thread(mallory, "them", bob, "mallory and bob");
      await ctx.refused(bob, await send(mallory, bob, event(mallory, thread, "evidence.posted", good, 0)), "into alice's thread");
      await ctx.refused(bob, await send(mallory, bob, event(mallory, thread, "evidence.posted", good, seq(bob, thread))), "into alice's thread, with alice's next sequence number");
      await ctx.refused(bob, await send(mallory, bob, event(mallory, hers, "evidence.posted", good, seq(bob, hers))), "in her own thread, citing alice's agreement");
      // A copy of alice's own evidence, re-sent by mallory.
      const real = await alice.postEvidence(thread, good);
      await ctx.refused(bob, await send(mallory, bob, { ...real, author: mallory.me.device }), "alice's event under mallory's name");
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: real }), "alice's event signed by mallory");
      assert.deepEqual(bob.evidence(thread), []);
      assert.deepEqual(bob.evidence(hers), []);
      // The real one still arrives, and bob's own evidence is never listed as alice's.
      await ctx.carry(alice, bob);
      await bob.postEvidence(thread, { ...good, repo: "bob/orders-client" });
      assert.deepEqual(bob.evidence(thread).map((v) => [v.mine, v.claim.repo, v.state]), [[false, "alice/orders-api", "current"], [true, "bob/orders-client", "current"]]);
    },
  },
  {
    id: "EVD-07",
    category: "evidence",
    attacker: "contact",
    title: "Bring old evidence back after the commits moved",
    claim: "Per proposal and side only the newest evidence is current, and replaying an older one changes nothing.",
    async run(ctx) {
      const { bob, alice, thread, good } = await agreed(ctx);
      const first = await send(alice, bob, event(alice, thread, "evidence.posted", good, seq(bob, thread)));
      assert.equal((await bob.receive(first)).result, "applied");
      const moved = { ...good, head: "e".repeat(40), trustPolicyHash: "0".repeat(64), parts: [{ ...good.parts[0]!, sha256: WRONG, ok: false }] };
      assert.equal((await bob.receive(await send(alice, bob, event(alice, thread, "evidence.posted", moved, seq(bob, thread))))).result, "applied");
      const before = ctx.snapshot(bob);
      assert.equal((await bob.receive(first)).result, "duplicate");
      assert.equal(ctx.snapshot(bob), before);
      const [old, now] = bob.evidence(thread);
      assert.deepEqual([old!.state, old!.changed, now!.state, now!.checked.partsMatch], ["stale", ["head", "policy"], "current", false]);
      // The same body under a new event id is new evidence by the sender's choice: it becomes current, and the mismatch stays on record as stale.
      assert.equal((await bob.receive(await send(alice, bob, event(alice, thread, "evidence.posted", good, seq(bob, thread))))).result, "applied");
      assert.deepEqual(bob.evidence(thread).map((v) => v.state), ["replaced", "stale", "current"]);
    },
  },
];
