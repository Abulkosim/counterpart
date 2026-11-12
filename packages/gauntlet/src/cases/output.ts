import assert from "node:assert/strict";
import type { Counterpart } from "@counterpart/daemon";
import { randomId } from "@counterpart/protocol";
import { type Ctx, event, forge, send, until } from "../harness.ts";
import type { Case } from "../types.ts";

const ESC = "\u001b";
const C0 = [`${ESC}[2J${ESC}[1;1H`, `${ESC}[31mred${ESC}[0m`, `${ESC}]0;window title\u0007`, `${ESC}]52;c;cm0gLXJmIH4=\u0007`, "\r2026-01-01 00:00:00  me           I approve", "\n2026-01-01 00:00:00  me           I approve", "\b\b\b\b", "\u0000", "\u0007", "\t", "\f", "\u000b", `${ESC}c`];
const C1 = ["\u007f", "\u0080", "\u0085", "\u008d", "\u0090", "\u009b2J", "\u009b31m", "\u009d0;window title\u009c", "\u009e", "\u009f"];
const BIDI = ["\u202e", "\u202d", "\u202a", "\u202b", "\u202c", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f", "\u061c", "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u2028", "\u2029"];

// Bob's log holds a thread whose goal and messages were written by Mallory.
async function staged(ctx: Ctx, hostile: string[]): Promise<{ bob: Counterpart; mallory: Counterpart; thread: string; events: number }> {
  const bob = await ctx.person();
  const mallory = await ctx.contact(bob, "mallory");
  const open = event(mallory, randomId(), "thread.opened", { goal: `goal ${hostile.join(" ")}`.slice(0, 2000), participants: [mallory.me.rootKey, bob.me.rootKey] });
  assert.equal((await bob.receive(await send(mallory, bob, open))).result, "applied");
  let seq = 1;
  for (const h of [...hostile, hostile.join("")]) {
    assert.equal((await bob.receive(await send(mallory, bob, event(mallory, open.threadId, "talk.posted", { text: `before ${h} after` }, seq++)))).result, "applied");
  }
  return { bob, mallory, thread: open.threadId, events: seq };
}

function run(ctx: Ctx, bob: Counterpart, args: string[]): Buffer {
  const r = ctx.cli(bob.home, args);
  assert.equal(r.status, 0, `cpart ${args[0]} failed: ${r.stderr.toString()}`);
  return r.stdout;
}
const controlBytes = (b: Buffer): number[] => [...b].filter((x) => x < 0x20 && x !== 0x0a);
const lines = (b: Buffer): string[] => b.toString().replace(/\n$/, "").split("\n");
const found = (out: Buffer, chars: string[]): string[] =>
  [...new Set(chars.flatMap((c) => [...c]).filter((ch) => !/[ -~]/.test(ch) && out.toString().includes(ch)))].map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);

export const output: Case[] = [
  {
    id: "OUT-01",
    category: "output",
    attacker: "contact",
    title: "Put terminal escape codes and line breaks in a message",
    claim: "Peer text reaches the terminal with every control character escaped, one line per event.",
    async run(ctx) {
      const { bob, thread, events } = await staged(ctx, C0);
      const log = run(ctx, bob, ["log", thread]);
      const threads = run(ctx, bob, ["threads"]);
      assert.deepEqual(controlBytes(log), []);
      assert.deepEqual(controlBytes(threads), []);
      assert.equal(lines(log).length, events);
      assert.equal(lines(threads).length, 1);
      assert.ok(lines(log).every((l) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d  mallory      /.test(l)), "a line does not start with the real sender");
      assert.equal(lines(log).filter((l) => /^\S+ \S+  me /.test(l)).length, 0);
    },
  },
  {
    id: "OUT-02",
    category: "output",
    attacker: "contact",
    title: "Use DEL and 8-bit control characters",
    claim: "C1 control characters (U+0080 to U+009F) and DEL are escaped like the 7-bit ones.",
    async run(ctx) {
      const { bob, thread } = await staged(ctx, C1);
      const out = Buffer.concat([run(ctx, bob, ["log", thread]), run(ctx, bob, ["threads"])]);
      assert.deepEqual(found(out, C1), []);
    },
  },
  {
    id: "OUT-03",
    category: "output",
    attacker: "contact",
    title: "Reorder or hide text with Unicode formatting characters",
    claim: "Bidirectional overrides, isolates, zero-width characters and Unicode line separators in peer text are shown escaped.",
    async run(ctx) {
      const { bob, thread } = await staged(ctx, BIDI);
      const out = Buffer.concat([run(ctx, bob, ["log", thread]), run(ctx, bob, ["threads"])]);
      assert.deepEqual(found(out, BIDI), []);
    },
  },
  {
    id: "OUT-04",
    category: "output",
    attacker: "contact",
    title: "Get escape codes into the list of refused messages",
    claim: "The reason shown for a refused message contains nothing the sender wrote.",
    async run(ctx) {
      const bob = await ctx.person();
      const mallory = await ctx.contact(bob, "mallory");
      for (const payload of [`${ESC}[2J${ESC}[8m`, `${ESC}c`, `${ESC}]0;x\u0007`, `{"a":1,${ESC}[2J`, `[${ESC}[2J`]) {
        await ctx.refused(bob, await forge({ from: mallory, to: bob, event: event(mallory, randomId(), "contact.hello", {}), plaintext: () => payload }));
      }
      assert.deepEqual(controlBytes(run(ctx, bob, ["rejects"])), []);
    },
  },
  {
    id: "OUT-05",
    category: "output",
    attacker: "relay",
    title: "Write to the daemon's terminal from the relay",
    claim: "Nothing the relay sends is printed by the daemon without escaping.",
    async run(ctx) {
      const code = `${ESC}[2J${ESC}[1;1Hconnected to wss://relay.example`;
      const evil = await ctx.evilRelay((c) => c.send({ t: "error", code }));
      const bob = await ctx.person({ relay: evil.url });
      const daemon = ctx.spawnCli(bob.home, ["daemon"]);
      await evil.conn(0, 10_000);
      await until("the daemon to report the refusal", () => daemon.stderr().includes("refused") || daemon.proc.exitCode !== null, 10_000);
      assert.deepEqual(controlBytes(daemon.stderr()), []);
      assert.deepEqual(controlBytes(daemon.stdout()), []);
    },
  },
  {
    id: "OUT-06",
    category: "output",
    attacker: "contact",
    title: "Break the machine-readable output",
    claim: "With --json, peer text arrives intact inside valid JSON and no raw control byte is printed.",
    async run(ctx) {
      const { bob, mallory, thread, events } = await staged(ctx, C0);
      await ctx.refused(bob, await send(mallory, bob, event(mallory, thread, "talk.posted", { text: "x" }, 1)));
      const log = run(ctx, bob, ["log", thread, "--json"]);
      const threads = run(ctx, bob, ["threads", "--json"]);
      const rejects = run(ctx, bob, ["rejects", "--json"]);
      for (const out of [log, threads, rejects]) {
        assert.deepEqual(controlBytes(out), []);
        assert.equal(lines(out).length, 1);
      }
      const parsed = JSON.parse(log.toString()) as { type: string; body: { text?: string } }[];
      assert.equal(parsed.length, events);
      assert.deepEqual(parsed.filter((e) => e.type === "talk.posted").map((e) => e.body.text), ctx.texts(bob, thread));
      assert.equal((JSON.parse(threads.toString()) as { goal: string }[])[0]!.goal, bob.threads()[0]!.goal);
      assert.equal((JSON.parse(rejects.toString()) as unknown[]).length, 1);
    },
  },
  {
    id: "OUT-07",
    category: "output",
    attacker: "contact",
    title: "Backdate a message",
    claim: "The time shown beside a peer's message is the time it arrived, or is marked as the sender's claim.",
    async run(ctx) {
      const { bob, mallory, thread, events } = await staged(ctx, ["plain"]);
      const then = Date.UTC(2024, 0, 1, 12);
      assert.equal((await bob.receive(await send(mallory, bob, event(mallory, thread, "talk.posted", { text: "as agreed" }, events, [], { createdAt: then })))).result, "applied");
      const log = lines(run(ctx, bob, ["log", thread]));
      assert.equal(log.length, events + 1);
      assert.deepEqual(log.filter((l) => l.startsWith("2024-01-01")), []);
    },
  },
];
