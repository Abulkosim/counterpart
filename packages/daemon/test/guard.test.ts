import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Counterpart, type GuardOptions, HeldError } from "../src/index.ts";
import { measure } from "./guard-corpus/measure.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cpart-guard-"));
  dirs.push(d);
  return d;
};

const TOKEN = "Zt4mQ9vL2xR8pW1nK6sB3yH7cD5f";
const PASS = "alice-passphrase";

// Two people on one machine with no relay: what one queues is handed to the other.
async function pair(guard: GuardOptions, passphrase?: string): Promise<{ alice: Counterpart; bob: Counterpart; thread: string; carry: () => Promise<void> }> {
  const relay = "ws://127.0.0.1:9";
  const alice = await Counterpart.init(dir(), { relay, guard, ...(passphrase ? { passphrase, logN: 14 } : {}) });
  const bob = await Counterpart.init(dir(), { relay, guard: { env: {}, cwd: null } });
  const carry = async (): Promise<void> => {
    for (const [from, to] of [[alice, bob], [bob, alice]] as const) {
      for (const w of from.queued()) {
        if (w.header.to !== to.me.device) continue;
        await to.receive(w);
        from.markOutbox(w.header.id, "stored");
      }
    }
  };
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await carry();
  await carry();
  const thread = await alice.openThread("bob", "orders pagination");
  await carry();
  return { alice, bob, thread, carry };
}

const bobTexts = (bob: Counterpart, thread: string): string[] => bob.log(thread).filter((e) => e.type === "talk.posted").map((e) => (e.body as { text: string }).text);
const outbox = (node: Counterpart): number => {
  const db = new DatabaseSync(join(node.home, "state.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

test("corpus: no ordinary message is held, every planted secret is", () => {
  const r = measure();
  assert.ok(r.ordinary.total >= 500, `corpus has ${r.ordinary.total} ordinary messages`);
  assert.deepEqual(r.ordinary.held.map((h) => `${h.source}: ${h.findings.map((f) => f.rule).join(",")}: ${h.text.slice(0, 80)}`), []);
  assert.deepEqual(r.planted.missed, []);
  // What gitleaks' own fixtures hold that this misses: rules that match on a
  // file's path, which a message does not have, and two upstream samples.
  const pathRules = new Set(["freemius-secret-key", "hashicorp-tf-password", "kubernetes-secret-yaml", "nuget-config-password", "pkcs12-file", "gcp-service-account", "square-secret"]);
  assert.deepEqual([...new Set(r.gitleaks.missed.map((m) => m.rule))].filter((x) => !pathRules.has(x)), []);
  assert.ok(r.gitleaks.caught / r.gitleaks.tps > 0.99);
});

test("a secret from the sender's environment is held, plain or encoded, and the sender is told only the category", async () => {
  const { alice, bob, thread, carry } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  const before = alice.log(thread).length;
  const queued = outbox(alice);
  for (const text of [`the token is ${TOKEN}`, Buffer.from(TOKEN).toString("base64"), [...TOKEN].reverse().join(""), TOKEN.match(/.{1,4}/g)!.join(" ")]) {
    await assert.rejects(alice.say(thread, text, "agent"), (e: unknown) => {
      assert.ok(e instanceof HeldError);
      assert.match(e.message, /^held for your human, reason: env-secret/);
      assert.ok(!e.message.includes(TOKEN.slice(0, 8)));
      return true;
    });
  }
  assert.equal(alice.log(thread).length, before, "nothing entered the log");
  assert.equal(outbox(alice), queued, "nothing was queued");
  await carry();
  assert.deepEqual(bobTexts(bob, thread), []);
  const held = alice.guard.held();
  assert.equal(held.length, 4);
  assert.ok(held.every((h) => h.reasons.includes("env-secret") && h.type === "talk.posted"));
  // The record says where and how it matched, not the value.
  assert.ok(!JSON.stringify(held.map((h) => h.findings)).includes(TOKEN));
  const hows = new Set(held.flatMap((h) => h.findings.map((f) => f.how.split(">")[0])));
  for (const h of ["plain", "base64", "reversed", "split"]) assert.ok(hows.has(h), `found ${h}`);
});

test("a secret cut into pieces is held, in one message or across several", async () => {
  const { alice, bob, thread, carry } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  const q = TOKEN.match(/.{1,7}/g)!; // four pieces of seven, each too short to match alone
  await assert.rejects(alice.say(thread, `piece one ${q[0]}, piece two ${q[1]}, piece three ${q[2]}`), /env-secret/);
  await alice.say(thread, `first piece: ${q[0]}`);
  await assert.rejects(alice.say(thread, `second piece: ${q[1]}`), /env-secret/);
  await assert.rejects(alice.say(thread, TOKEN.slice(0, 14)), /env-secret/);
  await carry();
  assert.deepEqual(bobTexts(bob, thread), [`first piece: ${q[0]}`], "only the first seven characters left");
  assert.ok(alice.guard.held().some((h) => h.findings.some((f) => f.how === "across messages")));
});

test("ordinary messages go out unchanged", async () => {
  const { alice, bob, thread, carry } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  const text = `Pushed 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39. Request 4f1c2b9e-8a7d-4c3b-9e2f-1a0b9c8d7e6f returned {"items": [], "next": null}. Cursor ${Buffer.from('{"after":120}').toString("base64")}.`;
  await alice.say(thread, text);
  await carry();
  assert.deepEqual(bobTexts(bob, thread), [text]);
  assert.equal(alice.guard.counts().held, 0);
});

test("goals, contract text and attachments are checked too", async () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
  const { alice, thread } = await pair({ env: {}, cwd: null });
  const threads = alice.threads().length;
  await assert.rejects(alice.openThread("bob", `use this key: ${key}`), HeldError);
  assert.equal(alice.threads().length, threads, "no thread was opened");
  await assert.rejects(alice.propose(thread, { title: "Deploy", text: "Attached.", parts: [{ kind: "text", name: "key.txt", content: key }] }), HeldError);
  assert.equal(alice.contracts(thread).length, 0, "no proposal was made");
  assert.deepEqual(alice.guard.held().map((h) => [h.type, h.reasons.join()]), [["thread.opened", "private-key"], ["contract.proposed", "private-key"]]);
  assert.equal(alice.guard.held()[1]!.findings[0]!.field, "contract.parts.0.content");
});

test("release needs the passphrase, sends once, and drop sends nothing", async () => {
  const { alice, bob, thread, carry } = await pair({ env: { DB_PASSWORD: "correct-Horse-battery-77-staple" }, cwd: null }, PASS);
  await assert.rejects(alice.say(thread, "db password is correct-Horse-battery-77-staple"), HeldError);
  await assert.rejects(alice.say(thread, "again: correct-Horse-battery-77-staple"), HeldError);
  const [one, two] = alice.guard.held();
  await assert.rejects(alice.releaseHeld(one!.id), /needs your passphrase/);
  await assert.rejects(alice.releaseHeld(one!.id, "not-the-passphrase"), /wrong passphrase/);
  assert.equal(alice.guard.held().length, 2, "still held");
  const r = await alice.releaseHeld(one!.id.slice(0, 6), PASS);
  await carry();
  assert.deepEqual(bobTexts(bob, thread), ["db password is correct-Horse-battery-77-staple"]);
  assert.equal(r.threadId, thread);
  await assert.rejects(alice.releaseHeld(one!.id, PASS), /not held any more/);
  const dropped = alice.guard.drop(two!.id);
  assert.equal(dropped.state, "dropped");
  await carry();
  assert.equal(bobTexts(bob, thread).length, 1);
  const all = alice.guard.held(true);
  assert.deepEqual(all.map((h) => [h.state, h.body]), [["released", null], ["dropped", null]], "the text is not kept once it is decided");
  assert.equal(all[0]!.eventId, r.eventId);
});

test("a released opening goal opens the thread", async () => {
  const { alice, bob, carry } = await pair({ env: { INTERNAL_API_KEY: "a8f3k2m9q1w7e5r4t6y0u3i2o8p" }, cwd: null }, PASS);
  await assert.rejects(alice.openThread("bob", "key a8f3k2m9q1w7e5r4t6y0u3i2o8p"), HeldError);
  const r = await alice.releaseHeld(alice.guard.held()[0]!.id, PASS);
  await carry();
  assert.equal(bob.threads().find((t) => t.id === r.threadId)?.goal, "key a8f3k2m9q1w7e5r4t6y0u3i2o8p");
});

test(".env files in registered repositories and in the sender's own repository count", async () => {
  const root = dir();
  const registered = join(root, "api");
  const here = join(root, "client");
  const theirs = "Pq7Wm3Zx9Lk2Vb8Nc4Rt6Yh1";
  for (const [repo, line] of [[registered, `UPSTREAM_SYNC_KEY=${theirs}`], [here, "PARTNER_FEED_KEY=Hj3kL9mN2bV6cX1zQ8wE5rT4"]] as const) {
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "config"));
    writeFileSync(join(repo, "config", ".env.local"), `PORT=8080\n${line}\n`);
  }
  const { alice, thread } = await pair({ env: {}, cwd: join(here, "config") });
  await assert.rejects(alice.say(thread, "feed key Hj3kL9mN2bV6cX1zQ8wE5rT4"), /dotenv-value/);
  const hex = Buffer.from(theirs).toString("hex");
  await alice.say(thread, hex); // not registered yet, and no pattern knows it
  alice.guard.addPath("repo", registered);
  await assert.rejects(alice.say(thread, hex), /dotenv-value/);
  await alice.say(thread, "port is 8080");
});

test("text from a never-share file is held however it is spaced", async () => {
  const f = join(dir(), "notes.md");
  writeFileSync(f, "Northwind threatened to cancel unless the refund backlog is cleared by Friday.\nTheir CFO said the renewal is worth 1.4 million and they are talking to a competitor.\n");
  const { alice, thread } = await pair({ env: {}, cwd: null });
  alice.guard.addPath("never-share", f);
  await assert.rejects(alice.say(thread, "FYI: their cfo said   the renewal is worth 1.4 million and they are talking to a competitor"), /never-share-file/);
  await alice.say(thread, "The refund backlog is our priority this week.");
});

test("CPART_GUARD=off sends, says so every time, and records what it would have held", async () => {
  const lines: string[] = [];
  const { alice, bob, thread, carry } = await pair({ env: { CPART_GUARD: "off", ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null, log: (l) => lines.push(l) });
  lines.length = 0; // opening the thread was logged too
  await alice.say(thread, `token ${TOKEN}`);
  await alice.say(thread, "nothing secret here");
  await carry();
  assert.deepEqual(bobTexts(bob, thread), [`token ${TOKEN}`, "nothing secret here"]);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.startsWith("COUNTERPART OUTBOUND GUARD IS OFF")));
  assert.match(lines[0]!, /would have HELD it: env-secret/);
  assert.deepEqual(alice.guard.counts(), { held: 0, unguarded: 1 });
  assert.equal(alice.guard.held(true)[0]!.body, null, "an unguarded message is not stored a second time");
});

test("held ids, and a race to release", async () => {
  const { alice, thread } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  await assert.rejects(alice.say(thread, TOKEN), HeldError);
  const id = alice.guard.held()[0]!.id;
  assert.throws(() => alice.guard.find("ab"), /first 4 or more/);
  assert.throws(() => alice.guard.find("zzzz"), /no held message/);
  const results = await Promise.allSettled([alice.releaseHeld(id), alice.releaseHeld(id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(alice.log(thread).filter((e) => e.type === "talk.posted").length, 1);
});

test("a large message is checked in reasonable time", async () => {
  const { alice, thread } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  const big = Array.from({ length: 300 }, (_, i) => `line ${i}: api_key lookup for request ${i.toString(16).padStart(32, "0")} sha256 ${"ab".repeat(32)} payload ${Buffer.from(`{"page":${i}}`).toString("base64")}`).join("\n").slice(0, 16000);
  const t = Date.now();
  await alice.say(thread, big);
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
});
