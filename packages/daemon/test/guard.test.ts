import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Counterpart, Guard, type GuardOptions, HeldError, WALK_DEPTH, dotenvFiles, walkLimit } from "../src/index.ts";
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

test("a token under a secret name in a config file is known exactly, so reversed or halved it is held", async () => {
  const repo = join(dir(), "svc");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "config"));
  const token = "pt_qwhzkdmrtplvbnxcaeoiuyjsgfwmrtqz"; // letters only: no pattern knows it
  writeFileSync(join(repo, "config", "production.yml"), `server:\n  port: 8080\n  timeout_ms: 5000\npayments:\n  endpoint: https://payments.internal.example/v1\n  token: ${token}\n`);
  writeFileSync(join(repo, "config", "app.json"), `{\n  "name": "orders",\n  "region": "eu-west-1"\n}\n`);
  const { alice, thread } = await pair({ env: {}, cwd: repo });
  await assert.rejects(alice.say(thread, `backwards: ${[...token].reverse().join("")}`), /config-value/);
  await assert.rejects(alice.say(thread, `second half: ${token.slice(18)}`), /config-value/);
  await alice.say(thread, "the endpoint is https://payments.internal.example/v1, timeout 5000, region eu-west-1");
});

test("values in the home directory's credential files are known exactly", async () => {
  const home = dir();
  mkdirSync(join(home, ".aws"));
  const secret = "wJalrXUtnFEMIK7MDENGbPxRfiCYzEXAMPLEKEYq";
  writeFileSync(join(home, ".aws", "credentials"), `[default]\naws_access_key_id = AKIAQ3EXAMPLE7KZW2TP\naws_secret_access_key = ${secret}\nregion = eu-west-1\n`);
  writeFileSync(join(home, ".netrc"), "machine api.example.com login bob password Zr8vKq2mWx5nLp\n");
  const { alice, thread } = await pair({ env: { HOME: home }, cwd: null });
  await assert.rejects(alice.say(thread, `the rest of it: ${secret.slice(20)}`), /config-value/);
  await assert.rejects(alice.say(thread, "pw Zr8vKq2mWx5nLp"), /config-value/);
  await alice.say(thread, "we deploy to eu-west-1");
});

test("text from a never-share file is held however it is spaced", async () => {
  const f = join(dir(), "notes.md");
  writeFileSync(f, "Northwind threatened to cancel unless the refund backlog is cleared by Friday.\nTheir CFO said the renewal is worth 1.4 million and they are talking to a competitor.\n");
  const { alice, thread } = await pair({ env: {}, cwd: null });
  alice.guard.addPath("never-share", f);
  await assert.rejects(alice.say(thread, "FYI: their cfo said   the renewal is worth 1.4 million and they are talking to a competitor"), /never-share-file/);
  await alice.say(thread, "The refund backlog is our priority this week.");
});

test("off in code sends, says so every time, and records what it would have held", async () => {
  const lines: string[] = [];
  const { alice, bob, thread, carry } = await pair({ off: true, env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null, log: (l) => lines.push(l) });
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
  const { alice, thread } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null }, PASS);
  await assert.rejects(alice.say(thread, TOKEN), HeldError);
  const id = alice.guard.held()[0]!.id;
  assert.throws(() => alice.guard.find("ab"), /first 4 or more/);
  assert.throws(() => alice.guard.find("zzzz"), /no held message/);
  const results = await Promise.allSettled([alice.releaseHeld(id, PASS), alice.releaseHeld(id, PASS)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(alice.log(thread).filter((e) => e.type === "talk.posted").length, 1);
  assert.equal(alice.guard.held(true)[0]!.state, "released");
});

test("an identity without a passphrase cannot release", async () => {
  const { alice, thread } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  await assert.rejects(alice.say(thread, TOKEN), HeldError);
  await assert.rejects(alice.releaseHeld(alice.guard.held()[0]!.id), /without a passphrase/);
  assert.equal(alice.guard.counts().held, 1);
});

test("two halves sent at the same moment: the second is held", async () => {
  const { alice, bob, thread, carry } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  const [a, b] = [TOKEN.slice(0, 8), TOKEN.slice(8, 16)];
  const r = await Promise.allSettled([alice.say(thread, `one: ${a}`), alice.say(thread, `two: ${b}`)]);
  assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  await carry();
  assert.equal(bobTexts(bob, thread).length, 1);
  assert.equal(alice.guard.counts().held, 1);
});

test("what Codex found: composed encodings, encoded pieces, capability URLs, limits, invite tokens", async () => {
  const hook = "https://hooks.example.test/invoke/Qm7Xr2Lp9Vt4Zc8Nb3Kw6Hy1";
  const { alice, thread } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN, SERVICE_WEBHOOK: hook, AUTH_URL: "https://auth.example.com/login" }, cwd: null });
  const b64 = (s: string): string => Buffer.from(s).toString("base64");
  // Reversed base64.
  await assert.rejects(alice.say(thread, [...b64(TOKEN)].reverse().join("")), /env-secret/);
  // Four pieces of seven, each base64 and sent alone: the second piece completes enough.
  const q = TOKEN.match(/.{1,7}/g)!;
  await alice.say(thread, `piece: ${b64(q[0]!)}`);
  await assert.rejects(alice.say(thread, `piece: ${b64(q[1]!)}`), /env-secret/);
  // A secret-named URL with a key in its path, and the key alone. A URL with no key in it is not a secret.
  await assert.rejects(alice.say(thread, `post to ${hook}`), /env-secret/);
  await assert.rejects(alice.say(thread, "the id is Qm7Xr2Lp9Vt4Zc8Nb3Kw6Hy1"), /env-secret/);
  await alice.say(thread, "log in at https://auth.example.com/login");
  // Hundreds of encoded notes are all read, and harmless ones go out.
  const many = Array.from({ length: 700 }, (_, i) => b64(`harmless note number ${i}`)).join(" ");
  await alice.say(thread, many.slice(0, 16000));
  // Encodings nested past the last level are held, not sent half-checked.
  let nested = `the token is ${TOKEN} and that is all`;
  for (let i = 0; i < 6; i++) nested = b64(nested);
  await assert.rejects(alice.say(thread, nested.slice(0, 16000)), /too-much-to-check/);
  // A huge run of character codes does not crash the check.
  // (It is then refused for its length, as before.)
  await assert.rejects(alice.say(thread, "65 ".repeat(200_000)), (e: Error) => !(e instanceof RangeError) && /bad talk.posted body|held/.test(e.message));
  assert.doesNotThrow(() => alice.guard.check({ text: "65 ".repeat(300_000) }));
});

test("what the second review found: rot13 inside base64, deep nesting, tiny pieces, padding, encoded URL parts, broken files, repeats", async () => {
  const b64 = (x: string): string => Buffer.from(x).toString("base64");
  const rot = (x: string): string => x.replace(/[A-Za-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - (c <= "Z" ? 65 : 97) + 13) % 26) + (c <= "Z" ? 65 : 97)));
  const hook = `https://example.test/hook?token=${[...Buffer.from("Wq8Pz3Lm6Tr1Vb9Kc4Ns7Hd2")].map((x) => `%${x.toString(16)}`).join("")}`;
  const { alice, thread } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN, WEBHOOK_URL: hook, CPART_PASSPHRASE: "build1build1build1" }, cwd: null });
  await assert.rejects(alice.say(thread, b64(rot(TOKEN))), /env-secret/);
  let deep = TOKEN;
  for (let i = 0; i < 4; i++) deep = b64(deep);
  await assert.rejects(alice.say(thread, deep), /env-secret/);
  await assert.rejects(alice.say(thread, b64(b64(deep))), /env-secret|too-much-to-check/);
  await assert.rejects(alice.say(thread, "the id is Wq8Pz3Lm6Tr1Vb9Kc4Ns7Hd2"), /env-secret/);
  // A value with a repeating part: one copy of the part is not ten characters of it.
  await alice.say(thread, "rebuild with build1 tonight");

  const second = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  const four = TOKEN.match(/.{1,4}/g)!;
  await second.alice.say(second.thread, `p ${four[0]}`);
  await second.alice.say(second.thread, `p ${four[1]}`);
  await assert.rejects(second.alice.say(second.thread, `p ${four[2]}`), /env-secret/);

  const third = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  const pad = "lorem ipsum dolor sit amet ".repeat(170);
  await third.alice.say(third.thread, `${pad} ${TOKEN.slice(0, 6)} ${pad}`);
  await assert.rejects(third.alice.say(third.thread, `${pad} ${TOKEN.slice(6, 12)} ${pad}`), /env-secret/);

  const f = join(dir(), "notes.md");
  writeFileSync(f, "internal notes, never to be shared with anyone outside\n");
  third.alice.guard.addPath("never-share", f);
  rmSync(f);
  await assert.rejects(third.alice.say(third.thread, "an ordinary message"), /never-share-unreadable/);
});

test("many copies of one token in a never-share file and a long run of one piece do not take long", async () => {
  const f = join(dir(), "dump.txt");
  writeFileSync(f, `${"Zt4mQ9vL2xR8pW1nK6sB3yH7cD5fAa9 ".repeat(100_000)}`);
  const { alice, thread } = await pair({ env: {}, cwd: null });
  alice.guard.addPath("never-share", f);
  const t = Date.now();
  await assert.rejects(alice.say(thread, "Zt4mQ9vL2x ".repeat(1400)), /never-share-file/);
  assert.ok(Date.now() - t < 15_000, `took ${Date.now() - t} ms`);
});

test("an invite whose token was made from a secret is not accepted", async () => {
  const relay = "ws://127.0.0.1:9";
  const inviter = await Counterpart.init(dir(), { relay, guard: { env: {}, cwd: null } });
  const me = await Counterpart.init(dir(), { relay, guard: { env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null } });
  const real = JSON.parse(Buffer.from(inviter.createInvite("me").replace(/^cpart-invite:/, ""), "base64url").toString()) as Record<string, unknown>;
  const forged = `cpart-invite:${Buffer.from(JSON.stringify({ ...real, token: TOKEN })).toString("base64url")}`;
  await assert.rejects(me.acceptInvite(forged, "them"), /looks like it carries a secret/);
  assert.equal(me.contacts().length, 0);
  assert.equal(me.queued().length, 0);
});

test("a never-share file is kept by its real path, and a missing one is reported", async () => {
  const d = dir();
  const real = join(d, "notes.md");
  writeFileSync(real, "Their CFO said the renewal is worth 1.4 million and they are talking to a competitor.\n");
  symlinkSync(real, join(d, "link.md"));
  const { alice } = await pair({ env: {}, cwd: null });
  assert.equal(alice.guard.addPath("never-share", join(d, "link.md")), real);
  assert.deepEqual(alice.guard.problems(), []);
  rmSync(real);
  assert.match(alice.guard.problems()[0]!, /cannot be found/);
});

test("a large message is checked in reasonable time", async () => {
  const { alice, thread } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  const big = Array.from({ length: 300 }, (_, i) => `line ${i}: api_key lookup for request ${i.toString(16).padStart(32, "0")} sha256 ${"ab".repeat(32)} payload ${Buffer.from(`{"page":${i}}`).toString("base64")}`).join("\n").slice(0, 16000);
  const t = Date.now();
  await alice.say(thread, big);
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
});

const guardOn = (opts: GuardOptions): Guard => new Guard(new DatabaseSync(":memory:"), opts, Date.now, "no-root-key");

test("CPART_GUARD=off in the environment changes nothing; only the owner's signed word turns the guard off", async () => {
  const lines: string[] = [];
  let now = Date.now();
  const relay = "ws://127.0.0.1:9";
  const alice = await Counterpart.init(dir(), { relay, passphrase: PASS, logN: 14, now: () => now, guard: { env: { CPART_GUARD: "off", ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null, log: (l) => lines.push(l) } });
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
  const thread = await alice.openThread("bob", "orders");
  // The variable an agent could set from a shell does nothing.
  await assert.rejects(alice.say(thread, `token ${TOKEN}`), HeldError);
  assert.equal(alice.guard.off, false);
  // Nor does a row written into state.db by hand.
  const db = new DatabaseSync(join(alice.home, "state.db"));
  db.prepare("INSERT INTO guard_off (id, until, sig, at) VALUES (1, ?, ?, ?)").run(now + 3600_000, "A".repeat(86), now);
  assert.equal(alice.guard.off, false);
  await assert.rejects(alice.say(thread, `token ${TOKEN}`), HeldError);
  db.exec("DELETE FROM guard_off");
  assert.throws(() => alice.guard.setOff(now + 60_000, "A".repeat(86)), /not signed/);
  assert.throws(() => bob.guardOff(10), /without a passphrase/);
  // The owner, with the passphrase.
  assert.throws(() => alice.guardOff(10, "wrong"), /wrong passphrase/);
  assert.throws(() => alice.guardOff(10_000, PASS), /from 1 to/);
  const until = alice.guardOff(10, PASS);
  assert.equal(alice.guard.offUntil(), until);
  lines.length = 0;
  await alice.say(thread, `token ${TOKEN}`);
  assert.match(lines[0]!, /^COUNTERPART OUTBOUND GUARD IS OFF \(until .*cpart guard off/);
  assert.deepEqual(alice.guard.counts(), { held: 2, unguarded: 1 });
  // The signed end time cannot be moved: changing it breaks the signature.
  db.prepare("UPDATE guard_off SET until = until + 3600000").run();
  assert.equal(alice.guard.off, false);
  db.prepare("UPDATE guard_off SET until = until - 3600000").run();
  assert.equal(alice.guard.off, true);
  // It ends by itself, or with cpart guard on.
  now += 11 * 60_000;
  assert.equal(alice.guard.off, false);
  await assert.rejects(alice.say(thread, `token ${TOKEN}`), HeldError);
  now -= 11 * 60_000;
  assert.equal(alice.guard.off, true);
  assert.equal(alice.guard.clearOff(), true);
  assert.equal(alice.guard.off, false);
  db.close();
  await carry();
  assert.deepEqual(bobTexts(bob, thread), [`token ${TOKEN}`]);
});

test("names with KEY or PASS as a word count, as they do in .env files", () => {
  const values = { OPENAI_KEY: "Rk2pW9xL4mT7vQ1zN8bC3dF6", HMAC_KEY: "Mz5xC8vB1nQ4wE7rT2yU9iO3", PARTNER_FEED_KEY: "Hj3kL9mN2bV6cX1zQ8wE5rT4", SMTP_PASS: "plain words pass", KEY_PAIR_SEED: "Ab8cD3eF7gH2iJ6k" };
  const g = guardOn({ env: values, cwd: null });
  for (const [k, v] of Object.entries(values)) assert.ok(g.check({ text: `value: ${v}` }).some((f) => f.rule === `env:${k}`), k);
  // A path, an id, or KEY inside another word is left alone.
  const other = guardOn({ env: { SSH_KEY_PATH: "/home/me/.ssh/id_ed25519", MONKEY: "Zz9yY8xX7wW6vV5u", SORT_KEY_ID: "Pq7wE2rT9yU4iO1p", CACHE_KEY_PREFIX: "orders-cache-v2" }, cwd: null });
  assert.deepEqual(other.check({ text: "/home/me/.ssh/id_ed25519 Zz9yY8xX7wW6vV5u Pq7wE2rT9yU4iO1p orders-cache-v2" }).filter((f) => f.rule.startsWith("env:")), []);
});

test("encodings a fooled agent might be told to use: UTF-16, HTML references, octal, binary, gzip", () => {
  const g = guardOn({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  const codes = [...TOKEN].map((c) => c.charCodeAt(0));
  const forms = {
    "utf-16 base64": Buffer.from(TOKEN, "utf16le").toString("base64"),
    "html decimal": codes.map((c) => `&#${c};`).join(""),
    "html hex": codes.map((c) => `&#x${c.toString(16)};`).join(""),
    octal: codes.map((c) => `\\${c.toString(8)}`).join(""),
    binary: codes.map((c) => c.toString(2).padStart(8, "0")).join(" "),
    "gzip base64": gzipSync(TOKEN).toString("base64"),
    "gzip hex": gzipSync(`config dump: ${TOKEN}`).toString("hex"),
  };
  for (const [name, text] of Object.entries(forms)) assert.ok(g.check({ text: `here: ${text}` }).some((f) => f.category === "env-secret"), name);
  // A compression bomb is not inflated past its bound; it is held as too much to check.
  assert.ok(g.check({ text: gzipSync(Buffer.alloc(4 * 1024 * 1024, 65)).toString("base64") }).some((f) => f.category === "too-much-to-check"));
  // So are many small ones that add up: the bound is for all of a field.
  const small = gzipSync(Buffer.alloc(300 * 1024, 65)).toString("base64");
  assert.ok(g.check({ text: Array.from({ length: 8 }, () => small).join(" ") }).some((f) => f.category === "too-much-to-check"));
  // Ordinary text with the same shapes passes.
  assert.deepEqual(g.check({ text: "Use &amp; and &#169; in the footer; modes 0644 and 0755; mask 11111111 00000000." }), []);
});

test("the .env search goes deep, and says where it stopped", () => {
  const root = dir();
  mkdirSync(join(root, ".git"));
  const deep = join(root, "a", "b", "c", "d", "e", "f");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, ".env"), "DEEP_API_KEY=Hx7pL2mQ9rT4vW8zK3nB6cY1\n");
  const lines: string[] = [];
  const g = guardOn({ env: {}, cwd: root, log: (l) => lines.push(l) });
  assert.ok(g.check({ text: "Hx7pL2mQ9rT4vW8zK3nB6cY1" }).some((f) => f.category === "dotenv-value"));
  assert.deepEqual(g.problems(), []);
  mkdirSync(join(root, ...Array.from({ length: WALK_DEPTH + 2 }, (_, i) => `d${i}`)), { recursive: true });
  assert.match(g.problems().join("\n"), new RegExp(`deeper than ${WALK_DEPTH} directories`));
  g.check({ text: "hello" });
  assert.match(lines.join("\n"), /\.env search stopped early/);
  const limit = walkLimit();
  limit.dirs = 3;
  dotenvFiles(root, limit);
  assert.deepEqual([...limit.cut], [root]);
});

test("a large never-share file does not make a send slow, and the second look inside the commit is cheap", async () => {
  const rows: string[] = [];
  for (let n = 0; n < 1_500_000; ) {
    const r = `${randomBytes(6).toString("hex")},customer ${rows.length},${randomBytes(12).toString("base64")},2026-01-01\n`;
    rows.push(r);
    n += r.length;
  }
  const f = join(dir(), "customers.csv");
  writeFileSync(f, rows.join(""));
  const { alice, thread } = await pair({ env: { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: null });
  alice.guard.addPath("never-share", f);
  await alice.say(thread, "warm up");
  const log = `build log: ${randomBytes(11_000).toString("base64")}`;
  let t = Date.now();
  await alice.say(thread, log);
  assert.ok(Date.now() - t < 8000, `a 15K message took ${Date.now() - t} ms`);
  t = Date.now();
  await assert.rejects(alice.say(thread, `row: ${rows[700]}`), /never-share-file/);
  assert.ok(Date.now() - t < 8000, `took ${Date.now() - t} ms`);
  // Inside the commit: nothing sent since screen(), so nothing is scanned again.
  const out = { contactRoot: alice.contacts()[0]!.rootKey, threadId: thread, type: "talk.posted", body: { text: log } };
  const ticket = alice.guard.screen(out);
  t = Date.now();
  alice.guard.recheck(out, ticket);
  assert.ok(Date.now() - t < 200, `recheck took ${Date.now() - t} ms`);
});

test("a known value spelled out word by word is held", async () => {
  const home = dir();
  mkdirSync(join(home, ".aws"));
  const id = "AKIAQ3EXAMPLE7KZW2TP";
  writeFileSync(join(home, ".aws", "credentials"), `[default]\naws_access_key_id = ${id}\n`);
  const { alice, thread } = await pair({ env: { HOME: home }, cwd: null });
  const NATO: Record<string, string> = { a: "Alfa", k: "Kilo", i: "India", q: "Quebec", e: "Echo", x: "X-ray", m: "Mike", p: "Papa", l: "Lima", z: "Zulu", w: "Whiskey", t: "Tango" };
  const DIG = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const spell = [...id].map((c) => (/\d/.test(c) ? DIG[Number(c)] : NATO[c.toLowerCase()])).join(" ");
  await assert.rejects(alice.say(thread, `key id, spelled: ${spell}`), /config-value/);
  await alice.say(thread, "Echo the request back, then call Victor on line two. Alpha release is on Tuesday, Bravo team owns it.");
});

test("sentences, words and test data in config files are not secrets", async () => {
  const repo = join(dir(), "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "results"));
  mkdirSync(join(repo, "test", "fixtures"), { recursive: true });
  // A data file with prose under secret-looking names, as red-team results have.
  writeFileSync(join(repo, "settings.json"), `{\n  "auth": "every request needs an Authorization header with your key",\n  "session": "orders-service",\n  "token": "\${ORDERS_TOKEN}"\n}\n`);
  writeFileSync(join(repo, "results", "run.json"), `{\n  "token": "Zk8mQ2vX9pL4nR7tW3yB6cJ1"\n}\n`);
  writeFileSync(join(repo, "test", "fixtures", "app.yml"), `password: Hq7rT2mV9xK4pW8nL3sZ\n`);
  const { alice, thread } = await pair({ env: {}, cwd: repo });
  assert.equal(alice.guard.secrets().exact.length, 0);
  await alice.say(thread, "Every request needs an Authorization header with your key; see orders-service.");
});

test("placeholders in .env templates are not secrets; values in the real .env still are", async () => {
  const repo = join(dir(), "orders-service");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const key = "sk_live_Wq8Pz3Lm6Tr1Vb9Kc4Ns7Hd2Xy5Fg0Jt";
  const dbPass = "q7pl2mx9vr4tk8sb3yh7cd5f";
  // As in the red team's repository, where these two lines held 18 harmless messages.
  writeFileSync(join(repo, ".env.example"), "NODE_ENV=development\nPORT=8080\nORDERS_API_KEY=sk_live_REPLACE_ME\nDATABASE_URL=postgres://orders:orders@localhost:5432/orders\n");
  writeFileSync(join(repo, ".env"), `NODE_ENV=production\nPORT=8080\nORDERS_API_KEY=${key}\nDATABASE_URL=postgres://orders:${dbPass}@db.internal:5432/orders\nCACHE_URL=redis://cache:cache@localhost:6379\nSTRIPE_TEST_KEY=sk_test_CHANGE_ME\nTOTP_SECRET=N4R7QZK2MW5XPL3T====\n`);
  writeFileSync(join(repo, ".env.sample"), "API_TOKEN=changeme\nSESSION_SECRET=replace-me-with-something-long\nWEBHOOK_SECRET=TODO\nSMTP_PASSWORD=fixme_later_please\nMONGO_URL=mongodb://admin:admin@mongo:27017\nQUEUE_URL=amqp://guest:guest@127.0.0.1:5672\n");
  writeFileSync(join(repo, "app.example.env"), "SIGNING_KEY=your-signing-key-here\nPARTNER_FEED_KEY=Hj3kL9mN2bV6cX1zQ8wE5rT4\nREPORTS_DB=postgres://reports:Tq9Lx2Vm7Rz4Kp8N@localhost:5432/reports\n");
  const { alice, thread } = await pair({ env: {}, cwd: repo });
  const harmless = [
    "Copy .env.example to .env. It has ORDERS_API_KEY=sk_live_REPLACE_ME; put your own key there.",
    "Locally: DATABASE_URL=postgres://orders:orders@localhost:5432/orders",
    "API_TOKEN=changeme, SESSION_SECRET=replace-me-with-something-long, WEBHOOK_SECRET=TODO, SMTP_PASSWORD=fixme_later_please",
    "mongodb://admin:admin@mongo:27017 and amqp://guest:guest@127.0.0.1:5672, cache at redis://cache:cache@localhost:6379",
    "SIGNING_KEY=your-signing-key-here, STRIPE_TEST_KEY=sk_test_CHANGE_ME",
  ];
  for (const text of harmless) await alice.say(thread, text);
  await assert.rejects(alice.say(thread, `key: ${key}`), /dotenv-value/);
  await assert.rejects(alice.say(thread, `the db password is ${dbPass}`), /dotenv-value/);
  await assert.rejects(alice.say(thread, `postgres://orders:${dbPass}@db.internal:5432/orders`), /dotenv-value/);
  await assert.rejects(alice.say(thread, "totp N4R7QZK2MW5XPL3T===="), /dotenv-value/);
  // A value in a template that looks like a key was committed by mistake: it counts.
  await assert.rejects(alice.say(thread, "feed key Hj3kL9mN2bV6cX1zQ8wE5rT4"), /dotenv-value/);
  await assert.rejects(alice.say(thread, "reports password Tq9Lx2Vm7Rz4Kp8N"), /dotenv-value/);
  assert.equal(alice.guard.counts().held, 6);
});
