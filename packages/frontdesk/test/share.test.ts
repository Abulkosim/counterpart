import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Counterpart, RelayLink } from "@counterpart/daemon";
import { type Relay, startRelay } from "@counterpart/relay";
import { DatabaseSync } from "node:sqlite";
import { type Model, type ModelRequest, FrontDesk, Preparer, addShare, checkCitations, compose, findSecret, globToRegExp, readShare, removeShare, select, shareRules } from "../src/index.ts";

const dirs: string[] = [];
const stops: (() => Promise<void> | void)[] = [];
let relay: Relay;
before(async () => {
  relay = await startRelay();
});
after(async () => {
  for (const s of stops) await s();
  await relay.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cpart-share-"));
  dirs.push(d);
  return d;
};
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
function put(repo: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
}
function repo(files: Record<string, string>): string {
  const r = tmp();
  sh(r, "init", "-q", "-b", "main");
  put(r, files);
  sh(r, "add", "-A");
  sh(r, "commit", "-qm", "first");
  return r;
}

const ROOT = "root-key-of-bob";

test("globs match committed paths the way the help says", () => {
  assert.ok(globToRegExp("docs").test("docs/a.md"));
  assert.ok(globToRegExp("docs").test("docs/x/y.md"));
  assert.ok(!globToRegExp("docs").test("docsx/a.md"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/x/a.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/a.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/x/y/a.ts"));
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(!globToRegExp("a.md").test("a_md"));
});

test("reads only what is committed at HEAD: not edits, not untracked files, not ignored ones", () => {
  const r = repo({ "docs/api.md": "page size is 50\n", ".gitignore": "*.log\n" });
  writeFileSync(join(r, "docs/api.md"), "page size is 999 UNCOMMITTED\n");
  writeFileSync(join(r, "docs/new.md"), "untracked\n");
  writeFileSync(join(r, "docs/debug.log"), "ignored\n");
  put(r, { "docs/forced.log": "force-added\n" });
  sh(r, "add", "-f", "docs/forced.log");
  sh(r, "commit", "-qm", "forced");
  const home = tmp();
  const s = addShare(home, ROOT, r, ["docs"]);
  assert.deepEqual(s.files.map((f) => [f.path, f.text]), [["docs/api.md", "page size is 50\n"]]);
  assert.deepEqual(s.skipped, [{ path: "docs/forced.log", reason: "matched by an ignore rule" }]);
  assert.throws(() => addShare(home, ROOT, r, ["docs/new.md"]), /matches nothing committed at HEAD/);

  // A new commit is picked up on the next read, without sharing again.
  writeFileSync(join(r, "docs/api.md"), "page size is 60\n");
  sh(r, "commit", "-qam", "change");
  assert.equal(readShare(home, ROOT)!.files[0]!.text, "page size is 60\n");
});

test("refuses sensitive paths, never shares credentials, and skips files that look like they hold a secret", () => {
  const r = repo({
    "src/app.ts": "export const limit = 100;\n",
    "src/config.ts": 'export const stripe = "sk_live_51HxQ2bKz9vQ3c8d7e6f5g4h";\n',
    "src/keys.ts": "const k = `-----BEGIN RSA PRIVATE KEY-----\nabc\n`;\n",
    ".env": "TOKEN=abc\n",
    "package.json": '{"name":"x"}\n',
    "deploy.sh": "echo hi\n",
    ".ssh/id_ed25519": "key\n",
  });
  symlinkSync("/etc/passwd", join(r, "src/link.ts"));
  sh(r, "add", "-A");
  sh(r, "commit", "-qm", "more");
  const home = tmp();
  const s = addShare(home, ROOT, r, ["**"]);
  assert.deepEqual(s.files.map((f) => f.path), ["src/app.ts"]);
  const why = Object.fromEntries(s.skipped.map((k) => [k.path, k.reason]));
  assert.match(why[".env"]!, /credentials; never shared/);
  assert.match(why[".ssh/id_ed25519"]!, /credentials; never shared/);
  assert.match(why["package.json"]!, /--allow package\.json/);
  assert.match(why["deploy.sh"]!, /shell script/);
  assert.match(why["src/config.ts"]!, /Stripe key \(line 1\)/);
  assert.match(why["src/keys.ts"]!, /private key/);
  assert.match(why["src/link.ts"]!, /symbolic link/);

  // The owner can let a sensitive path through by name, but never credentials.
  const s2 = addShare(home, ROOT, r, [], ["package.json", ".env"]);
  assert.deepEqual(s2.files.map((f) => f.path), ["package.json", "src/app.ts"]);
  assert.ok(s2.skipped.some((k) => k.path === ".env"));
  assert.throws(() => addShare(home, ROOT, r, [], ["*.json"]), /exact name/);
});

test("patterns must stay inside the repository, and one repository per contact", () => {
  const r = repo({ "a.md": "a\n" });
  const home = tmp();
  for (const bad of ["../x", "/etc/passwd", "a/../../b", ":(glob)*", "!a.md", "a\\b"]) assert.throws(() => addShare(home, ROOT, r, [bad]), /inside the repository/, bad);
  addShare(home, ROOT, r, ["./a.md"]);
  assert.deepEqual(shareRules(home, ROOT).map((x) => x.pattern), ["a.md"]);
  assert.throws(() => addShare(home, ROOT, repo({ "b.md": "b\n" }), ["b.md"]), /One repository per contact/);
  assert.throws(() => removeShare(home, ROOT, ["nope"]), /nothing shared/);
  assert.equal(removeShare(home, ROOT, "all"), 1);
  assert.equal(readShare(home, ROOT), null);
  assert.throws(() => addShare(home, ROOT, tmp(), ["a.md"]), /not inside a Git repository/);
});

test("the secret scan catches common shapes and lets ordinary code through", () => {
  for (const s of [
    "AKIAIOSFODNN7EXAMPLE",
    "token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
    'api_key = "a8f9d0c7e6b5a4f3e2d1c0b9"',
    "DATABASE_URL=postgres://app:hunter2secret@db.internal/app",
    "Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ])
    assert.ok(findSecret(`x\n${s}\n`), s);
  for (const s of [
    "const token = req.headers.authorization;",
    "password: z.string().min(12),",
    "const secretKey = process.env.SECRET_KEY;",
    'apiKey: "YOUR_API_KEY_HERE"',
    "const passwordHash = sha256(salt + password);",
    'token = "xxxxxxxxxxxxxxxxxxxx"',
    "See https://example.com/docs for details.",
  ])
    assert.equal(findSecret(s), null, s);
});

test("citations are kept only when the file is shared and the quote is on those lines", () => {
  const files = new Map([["src/a.ts", "line one\nexport const PAGE = 50;\nline three\n"]]);
  const ok = 'The page size is 50 [src/a.ts:2 "export const PAGE = 50;"]';
  const r = checkCitations(
    [ok, "An uncited claim that the limit is 9000.", 'Wrong quote [src/a.ts:2 "PAGE = 70"]', 'Not shared [src/secret.ts:1 "x = 1"]', "No quote [src/a.ts:2]", 'Out of range [src/a.ts:90 "line one"]', '  Spacing is forgiven [src/a.ts:1-2 "line   one export const"]'].join("\n"),
    files,
  );
  assert.equal(r.text, `${ok}\n  Spacing is forgiven [src/a.ts:1-2 "line   one export const"]`);
  assert.equal(r.removed, 5);
  assert.deepEqual(r.citations, [{ path: "src/a.ts", start: 2, end: 2 }, { path: "src/a.ts", start: 1, end: 2 }]);
  assert.ok(r.problems.some((p) => /not shared/.test(p)));
});

test("a share larger than the budget is cut to the parts that match the question", () => {
  const filler = (n: number) => Array.from({ length: 400 }, (_, i) => `filler line ${n}-${i} about nothing in particular`).join("\n");
  const docs = [
    { path: "docs/a.md", text: filler(1) },
    { path: "docs/limits.md", text: `${filler(2)}\nThe relay keeps queued messages for seven days.\n${filler(3)}` },
    { path: "docs/c.md", text: filler(4) },
  ];
  const sel = select(docs, "How long does the relay keep queued messages?", 8000);
  assert.ok(sel.ranked);
  assert.ok(sel.chars <= 8000);
  const shown = sel.chunks.map((c) => c.lines.join("\n")).join("\n");
  assert.match(shown, /seven days/);
  // Small shares are shown whole.
  const all = select([{ path: "x.md", text: "one\ntwo\n" }], "anything", 8000);
  assert.equal(all.ranked, false);
  assert.deepEqual(all.chunks.map((c) => [c.path, c.start, c.end]), [["x.md", 1, 2]]);
});

// ---- the desk, end to end with a scripted model ----

async function until(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const texts = (n: Counterpart, thread: string): string[] => n.log(thread).filter((e) => e.type === "talk.posted" && e.status === "applied").map((e) => (e.body as { text: string }).text);
function scripted(...replies: (string | ((req: ModelRequest) => string))[]): Model & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  const m = async (req: ModelRequest): Promise<string> => {
    calls.push(req);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return typeof r === "function" ? r(req) : r;
  };
  return Object.assign(m, { calls });
}

async function deskWithRepo(model: Model) {
  const alice = await Counterpart.init(tmp(), { relay: relay.url });
  const bob = await Counterpart.init(tmp(), { relay: relay.url });
  for (const n of [alice, bob]) {
    const l = new RelayLink(n, { pollMs: 20 }).start();
    stops.push(() => l.stop());
  }
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await until("pairing", () => bob.contacts()[0]?.state === "active" && alice.contacts()[0]?.state === "active");
  const r = repo({ "docs/api.md": "# Orders\n\nGET /orders uses cursor pagination.\nThe page size is 50.\n", "internal/plan.md": "PRIVATE-PLAN-4412\n" });
  addShare(alice.home, alice.contact("bob").rootKey, r, ["docs"]);
  const desk = new FrontDesk(alice, model);
  stops.push(() => desk.close());
  desk.configure("bob", { enabled: true, owner: "Alice" });
  const ask = async (thread: string, text: string): Promise<void> => {
    const n = texts(alice, thread).length;
    await bob.say(thread, text);
    await until("alice receives it", () => texts(alice, thread).length > n);
    await desk.tick();
  };
  return { alice, bob, desk, ask, repo: r };
}

test("the desk answers from the repository with checked citations, and sees nothing that is not shared", async () => {
  const model = scripted(
    'GET /orders uses cursor pagination [docs/api.md:3 "uses cursor pagination"]\nPages hold 50 orders [docs/api.md:4 "The page size is 50."]\nAlso it supports GraphQL.',
  );
  const { alice, bob, desk, ask } = await deskWithRepo(model);
  const thread = await bob.openThread("alice", "orders API");
  await ask(thread, "how does /orders paginate?");
  await until("bob gets the answer", () => texts(bob, thread).length === 2);
  const reply = texts(bob, thread)[1]!;
  assert.match(reply, /cursor pagination \[docs\/api\.md:3/);
  assert.match(reply, /Pages hold 50/);
  assert.ok(!reply.includes("GraphQL"), "the uncited line is removed");
  assert.match(reply, /as committed at [0-9a-f]{12}/);
  const seen = model.calls[0]!.system;
  assert.match(seen, /3\| GET \/orders uses cursor pagination\./);
  assert.ok(!seen.includes("PRIVATE-PLAN-4412"));
  const [run] = desk.runs();
  assert.equal(run!.outcome, "answered");
  assert.deepEqual(run!.files, ["docs/api.md"]);
  assert.match(run!.detail!, /2 citations checked, 1 line removed \(a line with no citation\)/);
  void alice;
});

test("a reply with no valid citation goes to the owner, not to the contact", async () => {
  const model = scripted('The rate limit is 300 a minute [docs/api.md:4 "rate limit is 300"]\nIt is also on page 9 [internal/plan.md:1 "PRIVATE-PLAN-4412"]');
  const { bob, desk, ask } = await deskWithRepo(model);
  const thread = await bob.openThread("alice", "limits");
  await ask(thread, "what is the rate limit?");
  await until("bob gets the reply", () => texts(bob, thread).length === 2);
  assert.equal(texts(bob, thread)[1], "I can't answer that from what Alice has shared. I've passed the question to Alice.");
  assert.deepEqual(desk.asks().map((a) => a.question), ["what is the rate limit?"]);
  assert.equal(desk.runs()[0]!.outcome, "asked_human");
  assert.match(desk.runs()[0]!.detail!, /not at docs\/api\.md:4.*not shared/);
});

test("removing the share while the model works drops the reply; a new commit does not", async () => {
  let removeDuring = true;
  let home = "";
  let root = "";
  let r = "";
  const model = scripted((req) => {
    if (removeDuring) removeShare(home, root, "all");
    else {
      writeFileSync(join(r, "docs/api.md"), "changed\n");
      sh(r, "commit", "-qam", "edit");
    }
    void req;
    return 'Cursor [docs/api.md:3 "uses cursor pagination"]';
  });
  const d = await deskWithRepo(model);
  home = d.alice.home;
  root = d.alice.contact("bob").rootKey;
  r = d.repo;
  const t1 = await d.bob.openThread("alice", "one");
  await d.ask(t1, "paginate?");
  assert.match(d.desk.runs().at(-1)!.detail!, /sharing changed while answering/);
  assert.ok(!texts(d.alice, t1).some((t) => t.includes("Cursor")));

  addShare(home, root, r, ["docs"]);
  removeDuring = false;
  const t2 = await d.bob.openThread("alice", "two");
  await d.ask(t2, "paginate?");
  // Checked against the commit the model was shown, which still has the line.
  await until("bob gets the answer", () => texts(d.bob, t2).length === 2);
  assert.match(texts(d.bob, t2)[1]!, /^Cursor \[docs\/api\.md:3/);
});

test("a repository that disappears is reported to the owner and the thread is not retried forever", async () => {
  const model = scripted("unused");
  const { alice, bob, desk, ask, repo: r } = await deskWithRepo(model);
  rmSync(r, { recursive: true, force: true });
  const thread = await bob.openThread("alice", "q");
  await ask(thread, "hello?");
  await desk.tick();
  assert.equal(model.calls.length, 0);
  assert.equal(desk.runs().length, 1);
  assert.match(desk.runs()[0]!.detail!, /could not read what is shared/);
  // The contact is told it was passed on, without the reason; the owner gets the question.
  await until("bob is told", () => texts(bob, thread).length === 2);
  assert.equal(texts(bob, thread)[1], "This is Alice's front desk. I can't read what Alice shared right now, so I can't answer. I've passed the question to Alice.");
  assert.ok(!texts(bob, thread)[1]!.includes(r));
  assert.deepEqual(desk.asks().map((a) => a.question), ["hello?"]);
  assert.equal(texts(alice, thread).length, 2);
});

// ---- found in review ----

test("ignore rules are read from the commit, not from the index or the working tree", () => {
  const r = repo({ ".gitignore": "docs/db.txt\nbuild/\n", "docs/api.md": "ok\n" });
  put(r, { "docs/db.txt": "dump\n", "build/out.js": "x\n" });
  sh(r, "add", "-f", "docs/db.txt", "build/out.js");
  sh(r, "commit", "-qm", "oops");
  // Unstage the file and delete the ignore file: HEAD still has both.
  sh(r, "rm", "-q", "--cached", "docs/db.txt");
  rmSync(join(r, ".gitignore"));
  const s = addShare(tmp(), ROOT, r, ["docs", "build"]);
  assert.deepEqual(s.files.map((f) => f.path), ["docs/api.md"]);
  assert.deepEqual(s.skipped.map((k) => [k.path, k.reason]), [["build/out.js", "matched by an ignore rule"], ["docs/db.txt", "matched by an ignore rule"]]);
});

test("a path that is credentials stays refused even when another rule also matches it", () => {
  const r = repo({ "docs/.env.secret": "PASSWORD=hunter2\n", "docs/a.md": "a\n" });
  const s = addShare(tmp(), ROOT, r, ["docs"], ["docs/.env.secret"]);
  assert.deepEqual(s.files.map((f) => f.path), ["docs/a.md"]);
  assert.match(s.skipped[0]!.reason, /credentials; never shared/);
});

test("the secret scan sees assigned passwords with symbols, and stays fast on hostile input", () => {
  assert.ok(findSecret('{"db_password":"N7!vP2@xQ8#kL4$sT9"}'));
  assert.ok(findSecret("PASSWORD=hunter2x9"));
  assert.ok(findSecret('client_secret: "abcdefghijklmnopqrstuvwxyz"'));
  for (const evil of ["a.".repeat(100_000) + "secret=x", "eyJ".repeat(80_000), "github_pat_".repeat(20_000), "sk-".repeat(80_000), `${"password=".repeat(20_000)}x`]) {
    const t = Date.now();
    findSecret(evil);
    assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms on ${evil.slice(0, 12)}`);
  }
});

test("a long reply is cut between checked lines, never through a citation", () => {
  const share = { repo: "/r", commit: "c".repeat(40), files: [], skipped: [], bytes: 0, hash: "h", rulesHash: "r" };
  const files = new Map([["docs/a.md", "Safe material here\n"]]);
  const m = { kind: "repo" as const, hash: "h", rulesHash: "r", bundleHash: "b", system: "", share, files, shown: 1, ranked: false };
  const raw = `${"X".repeat(6001)} [docs/a.md:1 "Safe material"]\nShort [docs/a.md:1 "Safe material"]`;
  const c = compose(m, raw, "Alice", "q");
  assert.ok(c.reply!.length <= 6000);
  assert.ok(!c.reply!.includes("XXXX"));
  const many = Array.from({ length: 200 }, (_, i) => `Point ${i} [docs/a.md:1 "Safe material"]`).join("\n");
  const c2 = compose(m, many, "Alice", "q");
  assert.ok(c2.reply!.length <= 6000);
  for (const l of c2.reply!.split("\n").slice(0, -2)) assert.match(l, /\[docs\/a\.md:1 "Safe material"\]$/);
  assert.match(c2.reply!, /\[cut short\]/);
});

test("rules naming two repositories are refused when read", () => {
  const home = tmp();
  addShare(home, ROOT, repo({ "a.md": "a\n" }), ["a.md"]);
  const d = new DatabaseSync(join(home, "frontdesk.db"));
  d.prepare("INSERT INTO shares (contact_root, repo, pattern, kind, at) VALUES (?, ?, ?, ?, ?)").run(ROOT, "/elsewhere", "b.md", "path", 0);
  d.close();
  assert.throws(() => readShare(home, ROOT), /more than one repository/);
});

// ---- found in the second review ----

test("plain passwords in config files are caught by path and by content", () => {
  const r = repo({
    "config/secrets/database.yml": "production:\n  password: s3cr3t\n",
    "config/vault/app.yml": "a: b\n",
    "config/mail.yml": "smtp:\n  user: app\n  password: correcthorsebatterystaple\n",
    "config/db.yml": "host: db.internal\nPOSTGRES_PASSWORD: s3cr3t\n",
    "config/app.yml": "name: shop\npassword: required\n",
    "docs/auth.md": "Send `Authorization: Bearer 8f3a9c1b2d4e5f60718293a4` with each call.\n",
    "docs/ok.md": "Send `Authorization: Bearer <token>`.\n",
  });
  const s = addShare(tmp(), ROOT, r, ["config", "docs"]);
  assert.deepEqual(s.files.map((f) => f.path), ["config/app.yml", "docs/ok.md"]);
  const why = Object.fromEntries(s.skipped.map((k) => [k.path, k.reason]));
  assert.match(why["config/secrets/database.yml"]!, /named as a secret; share it with --allow/);
  assert.match(why["config/vault/app.yml"]!, /named as a secret/);
  assert.match(why["config/mail.yml"]!, /value assigned to password \(line 3\)/);
  assert.match(why["config/db.yml"]!, /POSTGRES_PASSWORD \(line 2\)/);
  assert.match(why["docs/auth.md"]!, /bearer token/);
  for (const t of ["password = hunter2", "DB_PASSWORD=correcthorsebatterystaple", "export PGPASSWORD=letmein", 'pwd: "abcd"']) assert.ok(findSecret(t), t);
  // Code that names a password without holding one.
  for (const t of ["password: string;", "const password = await read.password();", "password: newPassword,", "self.user, self.password = user, password", "passphrase: PASS,", "password = auth[2]", "password: $DB_PASSWORD"])
    assert.equal(findSecret(t), null, t);
});

test("an exact path with brackets can be shared", () => {
  const r = repo({ "app/[id]/page.tsx": "export default 1;\n", "app/x/page.tsx": "2\n" });
  assert.ok(globToRegExp("app/[id]/page.tsx").test("app/[id]/page.tsx"));
  assert.ok(!globToRegExp("app/[id]/page.tsx").test("app/i/page.tsx"));
  const s = addShare(tmp(), ROOT, r, ["app/[id]/page.tsx"]);
  assert.deepEqual(s.files.map((f) => f.path), ["app/[id]/page.tsx"]);
});

test("a large share is read off the daemon's thread, and a read that takes too long fails", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 24; i++) files[`docs/f${i}.md`] = `${randomBytes(120_000).toString("base64").replace(/(.{76})/g, "$1\n")}\n`;
  const r = repo(files);
  const home = tmp();
  addShare(home, ROOT, r, ["docs"]);
  const p = new Preparer();
  stops.push(() => p.close());
  let ticks = 0;
  const iv = setInterval(() => ticks++, 2);
  const started = Date.now();
  const m = await p.run(home, { name: "bob", rootKey: ROOT }, "Alice", "what is in f3");
  clearInterval(iv);
  assert.equal(m!.kind, "repo");
  assert.ok(m!.kind === "repo" && m!.ranked && m!.share.files.length === 24);
  // Had it run here, no timer could have fired until it was done.
  assert.ok(ticks >= 5, `${ticks} timer ticks in ${Date.now() - started} ms`);

  const slow = new Preparer({ timeoutMs: 1 });
  stops.push(() => slow.close());
  await assert.rejects(slow.run(home, { name: "bob", rootKey: ROOT }, "Alice", "q"), /took longer than/);
  // The first preparer's thread is still there for the next read.
  assert.equal(await p.run(home, { name: "bob", rootKey: "nobody" }, "Alice", "q"), null);
});
