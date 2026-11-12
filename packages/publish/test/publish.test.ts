import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Counterpart, RelayLink } from "@counterpart/daemon";
import type { Model } from "@counterpart/frontdesk";
import type { Agreement } from "@counterpart/protocol";
import { type Relay, startRelay } from "@counterpart/relay";
import { type WorkResult, apply, work } from "@counterpart/worker";
import { preparePublication, repoInit } from "../src/index.ts";

const SCHEMA = '{\n  "type": "object",\n  "required": ["data", "next_cursor"],\n  "properties": { "data": { "type": "array", "maxItems": 200 }, "next_cursor": { "type": ["string", "null"] } },\n  "additionalProperties": false\n}\n';
const HANDLER = "export function listOrders(q) {\n  return { data: [], total: 0 };\n}\n";
const NEW_HANDLER = "export function listOrders(q) {\n  return { data: [], next_cursor: null };\n}\n";

const dirs: string[] = [];
const links: RelayLink[] = [];
let relay: Relay;
let agreement: Agreement;
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cpart-p-"));
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
  const p = await alice.propose(thread, { title: "Orders page", text: "Follows the attached schema.", parts: [{ kind: "json-schema", name: "page.schema.json", content: SCHEMA }] });
  await until(() => bob.threads().length === 1 && bob.contracts(thread).length === 1);
  await alice.approve(thread, p.proposalId, p.hash, "alice-pass-1");
  await bob.approve(thread, p.proposalId, p.hash, "bob-pass-12");
  await until(() => alice.contracts(thread)[0]?.status === "agreed");
  agreement = alice.agreement(thread, p.proposalId);
});
after(async () => {
  for (const l of links) await l.stop();
  await relay.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const g = (repo: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A repository whose main branch already trusts the agreement, with a remote to push to.
async function scene(): Promise<{ repo: string; result: WorkResult }> {
  const repo = tmp();
  const files: Record<string, string> = {
    "src/orders.js": HANDLER,
    "fixtures/page/valid/last.json": '{"data":[],"next_cursor":null}',
    "fixtures/page/invalid/old.json": '{"data":[],"total":3}',
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  g(repo, "init", "-q", "-b", "main");
  g(repo, "remote", "add", "origin", "https://example.invalid/alice/shop.git");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  const written = repoInit(repo, agreement, [{ part: "page.schema.json", path: "schemas/page.schema.json", fixtures: { valid: "fixtures/page/valid", invalid: "fixtures/page/invalid" } }]);
  assert.deepEqual(written, [".counterpart/trust.json", ".counterpart/verify.mjs", ".github/workflows/counterpart-verify.yml"]);
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "trust");
  const model: Model = async (q) => {
    const mark = /The marker ([0-9a-f]{12})/.exec(q.system)![1];
    return `NOTES\ndone\n=== FILE ${mark} src/orders.js ===\n${NEW_HANDLER.trimEnd()}\n=== END ${mark} ===`;
  };
  const result = await work({ repo, paths: ["src/orders.js"], brief: "Implement it.", contract: agreement.contract, contact: "bob" }, model);
  apply(repo, result, result.workHash);
  return { repo, result };
}

test("repo init pins the people, the thread and the exact contract, and installs a verifier that runs alone", async () => {
  const { repo } = await scene();
  const trust = JSON.parse(readFileSync(join(repo, ".counterpart/trust.json"), "utf8"));
  assert.deepEqual(trust.parties, agreement.contract.parties);
  assert.equal(trust.bindings[0].contract, agreement.contractHash);
  assert.equal(trust.bindings[0].proposal, agreement.proposalId);
  assert.equal(trust.threads.length, 1);
  const wf = readFileSync(join(repo, ".github/workflows/counterpart-verify.yml"), "utf8");
  assert.match(wf, /workflow_dispatch/);
  assert.ok(!/pull_request_target|pull_request:/.test(wf), "never triggered by the pull request itself");
  assert.ok(!/run: .*under-review\/(?!$)/.test(wf.replace("--tree under-review", "")), "nothing from the pull request is executed");
  assert.match(wf, /persist-credentials: false/);
  for (const m of wf.matchAll(/^\s*(?:- )?uses: (\S+)/gm)) assert.match(m[1]!, /@[0-9a-f]{40}$/, `${m[1]} is pinned to a commit`);
  assert.throws(() => repoInit(repo, agreement, [{ part: "nope.json", path: "x.json" }]), /no attachment named/);
  assert.throws(() => repoInit(repo, agreement, [{ part: "page.schema.json", path: "../x.json" }]), /not a plain path/);
});

test("what would be published is exactly the reviewed work, the agreement and the bound part, and it passes the same check CI runs", async () => {
  const { repo, result } = await scene();
  const p = preparePublication(repo, agreement, result);
  assert.deepEqual(p.files, [`.counterpart/agreements/${agreement.proposalId}.json`, "schemas/page.schema.json", "src/orders.js"]);
  assert.equal(readFileSync(join(repo, "schemas/page.schema.json"), "utf8"), SCHEMA, "written from the signed contract, byte for byte");
  assert.equal(p.check.ok, true, JSON.stringify(p.check.checks.filter((c) => !c.ok)));
  assert.equal(p.base, "main");
  assert.ok(p.body.includes(agreement.contractHash) && p.body.includes(agreement.proposalId));
  assert.ok(!p.body.includes(agreement.contract.text), "the pull request body does not carry contract text");
  assert.equal(g(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "nothing is committed or switched until publish");

  // The same check, the way the workflow runs it: verifier and trust file from main, the change as data.
  const main = tmp();
  g(repo, "worktree", "add", "-q", "--detach", main, "main");
  const ok = spawnSync("node", [join(main, ".counterpart/verify.mjs"), "--tree", repo, "--trust", join(main, ".counterpart/trust.json")], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout);
  writeFileSync(join(repo, "schemas/page.schema.json"), SCHEMA.replace("200", "201"));
  const bad = spawnSync("node", [join(main, ".counterpart/verify.mjs"), "--tree", repo, "--trust", join(main, ".counterpart/trust.json")], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /not the text that was signed/);
});

test("publishing refuses work that was edited after review, stray changes, a moved branch, and a branch that trusts nothing", async () => {
  const a = await scene();
  writeFileSync(join(a.repo, "src/orders.js"), `${NEW_HANDLER}// one more thing\n`);
  assert.throws(() => preparePublication(a.repo, agreement, a.result), /not the reviewed work/);

  const b = await scene();
  writeFileSync(join(b.repo, "notes.txt"), "unrelated\n");
  assert.throws(() => preparePublication(b.repo, agreement, b.result), /not part of the reviewed work: notes\.txt/);

  const c = await scene();
  g(c.repo, "stash", "push", "-q", "-u", "-m", "cpart-test");
  writeFileSync(join(c.repo, "README.md"), "x\n");
  g(c.repo, "add", "-A");
  g(c.repo, "commit", "-q", "-m", "moved");
  assert.throws(() => preparePublication(c.repo, agreement, c.result), /has moved/);

  const d = await scene();
  const fresh = tmp();
  writeFileSync(join(fresh, "a.txt"), "a\n");
  g(fresh, "init", "-q", "-b", "main");
  g(fresh, "add", "-A");
  g(fresh, "commit", "-q", "-m", "init");
  assert.throws(() => preparePublication(fresh, agreement, { ...d.result, baseCommit: g(fresh, "rev-parse", "HEAD"), files: [], changes: [] }), /no \.counterpart\/trust\.json/);
});

test("the trust files are never written through a symlink", async () => {
  const repo = tmp();
  const outside = tmp();
  writeFileSync(join(repo, "a.txt"), "a\n");
  g(repo, "init", "-q", "-b", "main");
  symlinkSync(outside, join(repo, ".counterpart"));
  assert.throws(() => repoInit(repo, agreement, [{ part: "page.schema.json", path: "schemas/page.schema.json" }]), /not a plain directory/);
  assert.equal(existsSync(join(outside, "trust.json")), false);
});
