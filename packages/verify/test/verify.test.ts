import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Counterpart, RelayLink } from "@counterpart/daemon";
import { type Agreement, canonicalize as protocolCanonicalize, generateSigningKey, signApproval, verifyAgreement as protocolVerify } from "@counterpart/protocol";
import { type Relay, startRelay } from "@counterpart/relay";
// @ts-expect-error plain JavaScript on purpose: it is copied into other repos as one file
import { canonicalize, checkSchema, validate, verifyAgreement, verifyTree } from "../src/verify.mjs";

const VERIFIER = join(dirname(fileURLToPath(import.meta.url)), "../src/verify.mjs");
const SCHEMA = JSON.stringify({ type: "object", required: ["data", "next_cursor"], properties: { data: { type: "array", maxItems: 200, items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } }, next_cursor: { type: ["string", "null"] } }, additionalProperties: false }, null, 2) + "\n";

const dirs: string[] = [];
const links: RelayLink[] = [];
let relay: Relay;
let agreement: Agreement;
let parties: string[];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cpart-v-"));
  dirs.push(d);
  return d;
};

before(async () => {
  relay = await startRelay();
  const make = async (pass: string) => {
    const n = await Counterpart.init(tmp(), { relay: relay.url, passphrase: pass, logN: 14 });
    links.push(new RelayLink(n, { pollMs: 20 }).start());
    return n;
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 15));
    assert.ok(cond(), "timed out");
  };
  const [alice, bob] = [await make("alice-pass-1"), await make("bob-pass-12")];
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await until(() => alice.contacts()[0]?.state === "active" && bob.contacts()[0]?.state === "active");
  const thread = await alice.openThread("bob", "orders pagination");
  const p = await alice.propose(thread, { title: "Orders page", text: "The orders page response follows the attached schema.", parts: [{ kind: "json-schema", name: "page.schema.json", content: SCHEMA }] });
  await until(() => bob.threads().length === 1 && bob.contracts(thread).length === 1);
  await alice.approve(thread, p.proposalId, p.hash, "alice-pass-1");
  await bob.approve(thread, p.proposalId, p.hash, "bob-pass-12");
  await until(() => alice.contracts(thread)[0]?.status === "agreed");
  agreement = alice.agreement(thread, p.proposalId);
  parties = agreement.contract.parties;
});
after(async () => {
  for (const l of links) await l.stop();
  await relay.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A repo checkout that should pass, and the trust file its base branch would hold.
function repo(): { tree: string; trust: Buffer; write(rel: string, content: string): void } {
  const tree = tmp();
  const write = (rel: string, content: string): void => {
    mkdirSync(dirname(join(tree, rel)), { recursive: true });
    writeFileSync(join(tree, rel), content);
  };
  write(`.counterpart/agreements/${agreement.proposalId}.json`, JSON.stringify(agreement));
  write("schemas/page.schema.json", SCHEMA);
  write("fixtures/page/valid/one.json", JSON.stringify({ data: [{ id: "o_1" }], next_cursor: "abc" }));
  write("fixtures/page/valid/last.json", JSON.stringify({ data: [], next_cursor: null }));
  write("fixtures/page/invalid/no-cursor.json", JSON.stringify({ data: [] }));
  write("fixtures/page/invalid/extra.json", JSON.stringify({ data: [], next_cursor: null, total: 3 }));
  const trust = Buffer.from(JSON.stringify({ v: 1, parties, bindings: [{ part: "page.schema.json", path: "schemas/page.schema.json", fixtures: { valid: "fixtures/page/valid", invalid: "fixtures/page/invalid" } }] }));
  return { tree, trust, write };
}
const failures = (r: { checks: { ok: boolean; what: string; detail: string }[] }): string => r.checks.filter((c) => !c.ok).map((c) => `${c.what}: ${c.detail}`).join(" | ");

test("the standalone verifier agrees with the protocol package on canonical form and agreements", () => {
  for (const v of [agreement, { b: [1, "x", null, true], a: { z: 1, y: "é " } }, "\u0000", []]) assert.equal(canonicalize(v), protocolCanonicalize(v));
  assert.equal(verifyAgreement(JSON.parse(JSON.stringify(agreement))).contractHash, protocolVerify(agreement).contractHash);
  const mutations: ((a: Agreement) => void)[] = [
    (a) => (a.contract.text += " "),
    (a) => (a.contract.parts[0]!.content += " "),
    (a) => (a.approvals[0]!.approvedAt += 1),
    (a) => a.approvals.pop(),
    (a) => (a.approvals[1] = a.approvals[0]!),
    (a) => (a.proposalId = "A".repeat(22)),
    (a) => ((a.genesis.body as { goal: string }).goal = "other"),
    (a) => (a.approvals[1] = signApproval(generateSigningKey(), { threadGenesis: a.approvals[1]!.threadGenesis, proposalId: a.proposalId, contractHash: a.contractHash, parties: a.contract.parties, approvedAt: 1 })),
  ];
  for (const m of mutations) {
    const bad = JSON.parse(JSON.stringify(agreement)) as Agreement;
    m(bad);
    assert.throws(() => protocolVerify(bad), "the protocol package refuses it");
    assert.throws(() => verifyAgreement(bad), "the standalone verifier refuses it too");
  }
});

test("a tree that carries the signed schema and honest fixtures passes", () => {
  const { tree, trust } = repo();
  const r = verifyTree(tree, trust);
  assert.equal(r.ok, true, failures(r));
  assert.equal(r.checks.length, 6);
  assert.match(r.trustPolicyHash, /^[0-9a-f]{64}$/);
});

test("one changed byte in the schema fails", () => {
  const { tree, trust, write } = repo();
  write("schemas/page.schema.json", SCHEMA.replace("200", "201"));
  const r = verifyTree(tree, trust);
  assert.equal(r.ok, false);
  assert.match(failures(r), /not the text that was signed/);
});

test("a change cannot bring its own signers, redirect a binding, or drop the agreement", async () => {
  // Signed by two outsiders: valid signatures, wrong people.
  const outsiders = repo();
  const [x, y] = [generateSigningKey(), generateSigningKey()];
  const ps = [x.publicKey, y.publicKey].sort();
  const forged = JSON.parse(JSON.stringify(agreement)) as Agreement;
  forged.contract.parties = ps;
  (forged.genesis.body as { participants: string[] }).participants = ps;
  // (Rebuilding a fully valid outsider agreement needs their signatures over the new hashes.)
  const { contractHash, hashOf } = await import("@counterpart/protocol");
  forged.contractHash = contractHash(forged.contract);
  forged.approvals = [x, y].map((k) => signApproval(k, { threadGenesis: hashOf(forged.genesis), proposalId: forged.proposalId, contractHash: forged.contractHash, parties: ps, approvedAt: 1 })).sort((a, b) => (a.approver < b.approver ? -1 : 1));
  protocolVerify(forged);
  outsiders.write(`.counterpart/agreements/${agreement.proposalId}.json`, JSON.stringify(forged));
  assert.match(failures(verifyTree(outsiders.tree, outsiders.trust)), /people this repo does not trust/);

  // The tree's own copy of trust.json is ignored; only the one passed in counts.
  const selfTrust = repo();
  selfTrust.write(".counterpart/trust.json", JSON.stringify({ v: 1, parties: ps, bindings: [{ part: "page.schema.json", path: "decoy.json" }] }));
  selfTrust.write("schemas/page.schema.json", "{}");
  assert.equal(verifyTree(selfTrust.tree, selfTrust.trust).ok, false);

  const dropped = repo();
  rmSync(join(dropped.tree, ".counterpart"), { recursive: true });
  assert.match(failures(verifyTree(dropped.tree, dropped.trust)), /missing|no agreement/);

  const pinned = repo();
  const elsewhere = Buffer.from(JSON.stringify({ ...JSON.parse(pinned.trust.toString()), threads: ["A".repeat(43)] }));
  assert.match(failures(verifyTree(pinned.tree, elsewhere)), /thread this repo does not trust/);
});

test("fixtures must behave: a valid one that fails, or an invalid one that passes, fails the check", () => {
  const a = repo();
  a.write("fixtures/page/valid/broken.json", JSON.stringify({ data: [{ id: 5 }], next_cursor: null }));
  assert.match(failures(verifyTree(a.tree, a.trust)), /should satisfy the agreed schema/);
  const b = repo();
  b.write("fixtures/page/invalid/actually-fine.json", JSON.stringify({ data: [], next_cursor: null }));
  assert.match(failures(verifyTree(b.tree, b.trust)), /should be rejected/);
  const c = repo();
  rmSync(join(c.tree, "fixtures/page/invalid"), { recursive: true });
  assert.equal(verifyTree(c.tree, c.trust).ok, false);
});

test("symlinks, traversal and oversized files in the tree are refused, not followed", () => {
  const a = repo();
  const outside = tmp();
  writeFileSync(join(outside, "page.schema.json"), SCHEMA);
  rmSync(join(a.tree, "schemas"), { recursive: true });
  symlinkSync(outside, join(a.tree, "schemas"));
  assert.match(failures(verifyTree(a.tree, a.trust)), /symlink/);

  const b = repo();
  const up = Buffer.from(JSON.stringify({ v: 1, parties, bindings: [{ part: "page.schema.json", path: "../schemas/page.schema.json" }] }));
  assert.match(failures(verifyTree(b.tree, up)), /bad path/);

  const c = repo();
  c.write("fixtures/page/valid/huge.json", JSON.stringify({ data: [], next_cursor: "x".repeat(2 * 1024 * 1024) }));
  assert.match(failures(verifyTree(c.tree, c.trust)), /larger than/);
});

test("the schema checker supports a fixed set of keywords and refuses the rest", () => {
  assert.throws(() => checkSchema({ type: "string", pattern: "(a+)+$" }), /not supported/);
  assert.throws(() => checkSchema({ $ref: "https://evil.example/schema.json" }), /not supported/);
  assert.throws(() => checkSchema({ properties: { a: { format: "email" } } }), /not supported/);
  let deep: Record<string, unknown> = { type: "null" };
  for (let i = 0; i < 100; i++) deep = { items: deep };
  assert.throws(() => checkSchema(deep), /too deeply/);
  const s = { type: "object", required: ["n"], properties: { n: { type: "integer", minimum: 1, maximum: 9 }, tag: { enum: ["a", "b"] }, any: { anyOf: [{ type: "string" }, { type: "null" }] } }, additionalProperties: false };
  checkSchema(s);
  assert.deepEqual(validate(s, { n: 3, tag: "a", any: null }), []);
  for (const bad of [{}, { n: 0 }, { n: 1.5 }, { n: 2, tag: "c" }, { n: 2, any: 4 }, { n: 2, extra: 1 }, [], null]) assert.ok(validate(s, bad).length > 0, JSON.stringify(bad));
});

test("the file runs on its own from another directory, with nothing else from this repo", () => {
  const { tree, trust } = repo();
  const elsewhere = tmp();
  cpSync(VERIFIER, join(elsewhere, "verify.mjs"));
  writeFileSync(join(elsewhere, "trust.json"), trust);
  assert.ok(!/from "(?!node:)/.test(readFileSync(VERIFIER, "utf8")), "imports only Node built-ins");
  const ok = spawnSync("node", ["verify.mjs", "--tree", tree, "--trust", "trust.json"], { cwd: elsewhere, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /carries what both people signed/);
  writeFileSync(join(tree, "schemas/page.schema.json"), "{}\n");
  const bad = spawnSync("node", ["verify.mjs", "--tree", tree, "--trust", "trust.json", "--json"], { cwd: elsewhere, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  // A planted script in the tree is never run.
  const marker = join(elsewhere, "ran");
  writeFileSync(join(tree, "verify.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`);
  writeFileSync(join(tree, "package.json"), JSON.stringify({ scripts: { preinstall: `touch ${marker}` } }));
  spawnSync("node", ["verify.mjs", "--tree", tree, "--trust", "trust.json"], { cwd: elsewhere, encoding: "utf8" });
  assert.equal(existsSync(marker), false);
});
