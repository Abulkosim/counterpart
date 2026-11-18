import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Counterpart, RelayLink } from "@counterpart/daemon";
import { type Relay, startRelay } from "@counterpart/relay";
import { shareRules } from "@counterpart/frontdesk";
import { type Gate, shareCommand } from "../src/share.ts";

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
  const d = mkdtempSync(join(tmpdir(), "cpart-cli-share-"));
  dirs.push(d);
  return d;
};
function repo(files: Record<string, string>): string {
  const r = tmp();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: r, env });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(r, p, ".."), { recursive: true });
    writeFileSync(join(r, p), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: r, env });
  execFileSync("git", ["commit", "-qm", "first"], { cwd: r, env });
  return r;
}

const PASS = "correct horse battery";
// Alice, with bob as an active contact.
async function setup(passphrase?: string) {
  const alice = await Counterpart.init(tmp(), { relay: relay.url, logN: 14, ...(passphrase ? { passphrase } : {}) });
  const bob = await Counterpart.init(tmp(), { relay: relay.url });
  for (const n of [alice, bob]) {
    const l = new RelayLink(n, { pollMs: 20 }).start();
    stops.push(() => l.stop());
  }
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  const end = Date.now() + 10_000;
  while (alice.contacts()[0]?.state !== "active") {
    if (Date.now() > end) throw new Error("pairing timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
  return alice;
}
function gate(g: Partial<Gate> & { typed?: string; pass?: string }): Gate & { printed: string[]; asked: string[] } {
  const printed: string[] = [];
  const asked: string[] = [];
  return {
    tty: g.tty ?? false,
    yes: g.yes ?? false,
    envPassphrase: g.envPassphrase ?? false,
    print: (s) => void printed.push(s),
    line: async (p) => (asked.push(p), g.typed ?? ""),
    secret: async (p) => (asked.push(p), g.pass ?? ""),
    printed,
    asked,
  };
}
const safe = (s: string): string => s;

test("sharing needs the owner at a terminal; an agent without one is refused", async () => {
  const alice = await setup();
  const root = alice.contacts()[0]!.rootKey;
  const r = repo({ "docs/a.md": "a\n", "docs/b.md": "b\n", "package.json": "{}\n" });
  const run = (args: string[], g: Gate, allow?: string[]) => shareCommand(alice, alice.home, ["bob", ...args], { repo: r, safe, gate: g, ...(allow ? { allow } : {}) });

  await assert.rejects(run(["docs"], gate({})), /needs you, not your agent: run this in a terminal/);
  await assert.rejects(run(["docs"], gate({ yes: true, envPassphrase: true })), /--yes is only for scripts/);
  await assert.rejects(run([], gate({}), ["package.json"]), /in a terminal/);
  const wrong = gate({ tty: true, typed: "yes" });
  await assert.rejects(run(["docs"], wrong), /nothing was shared/);
  assert.deepEqual(shareRules(alice.home, root), []);
  // What would be shared is shown before the question, every file of it.
  assert.match(wrong.printed[0]!, /docs\/a\.md\n {2}docs\/b\.md/);
  assert.match(wrong.printed[0]!, /covers files you commit there later/);

  const ok = gate({ tty: true, typed: "share" });
  const res = await run(["docs"], ok);
  assert.match(res.human, /can read 2 files/);
  assert.deepEqual(ok.asked, ["Type share to let the front desk read these files: "]);
  assert.deepEqual(shareRules(alice.home, root).map((x) => x.pattern), ["docs"]);

  // list and remove need no confirmation.
  const never = { ...gate({}), line: () => Promise.reject(new Error("asked")), secret: () => Promise.reject(new Error("asked")) };
  assert.match((await shareCommand(alice, alice.home, ["list", "bob"], { safe, gate: never })).human, /docs\/a\.md/);
  assert.match((await shareCommand(alice, alice.home, ["remove", "bob"], { all: true, safe, gate: never })).human, /Removed 1 rule/);
});

test("with a passphrase, sharing needs it too, and scripts can pass --yes with CPART_PASSPHRASE", async () => {
  const alice = await setup(PASS);
  const root = alice.contacts()[0]!.rootKey;
  const r = repo({ "docs/a.md": "a\n", "package.json": "{}\n" });
  const run = (args: string[], g: Gate, allow?: string[]) => shareCommand(alice, alice.home, ["bob", ...args], { repo: r, safe, gate: g, ...(allow ? { allow } : {}) });

  await assert.rejects(run(["docs"], gate({ tty: true, typed: "share", pass: "not it" })), /wrong passphrase\. Nothing was shared/);
  await assert.rejects(run(["docs"], gate({ yes: true })), /--yes is only for scripts/);
  await assert.rejects(run(["docs"], gate({ yes: true, envPassphrase: true, pass: "not it" })), /wrong passphrase/);
  assert.deepEqual(shareRules(alice.home, root), []);

  const t = gate({ tty: true, typed: "share", pass: PASS });
  await run(["docs"], t);
  assert.deepEqual(t.asked, ["Type share to let the front desk read these files: ", "Passphrase: "]);
  const s = gate({ yes: true, envPassphrase: true, pass: PASS });
  await run([], s, ["package.json"]);
  assert.deepEqual(s.asked, ["Passphrase: "]);
  assert.deepEqual(shareRules(alice.home, root).map((x) => `${x.kind}:${x.pattern}`), ["allow:package.json", "path:docs"]);
});
