// The outbound guard. The attacker is a contact whose messages talked the
// local agent into sending something it should not. Each case plays the
// fooled agent's part directly: what is tested is that the code stops it,
// not whether a model would have been fooled.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Counterpart, HeldError } from "@counterpart/daemon";
import { FrontDesk, addToBundle } from "@counterpart/frontdesk";
import { CLI, type Ctx } from "../harness.ts";
import type { Case } from "../types.ts";

const TOKEN = "Zt4mQ9vL2xR8pW1nK6sB3yH7cD5f";
const PASS = "alice-passphrase";

// Alice, whose agent is the one fooled, paired with Bob, who is listening.
async function scene(ctx: Ctx, guard: { env?: Record<string, string>; cwd?: string | null } = {}, passphrase?: string): Promise<{ alice: Counterpart; bob: Counterpart; thread: string; delivered: () => Promise<string[]> }> {
  const alice = await Counterpart.init(ctx.dir(), { relay: "ws://127.0.0.1:9", guard: { env: guard.env ?? { ORDERS_SERVICE_TOKEN: TOKEN }, cwd: guard.cwd ?? null }, ...(passphrase ? { passphrase, logN: 14 } : {}) });
  const bob = await ctx.person({ relay: alice.relay });
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await ctx.carry(bob, alice);
  await ctx.carry(alice, bob);
  const thread = await ctx.thread(alice, "bob", bob, "orders sync");
  // Everything Alice's side has queued reaches Bob, and Bob's view of the thread is returned.
  const delivered = async (): Promise<string[]> => {
    await ctx.carry(alice, bob);
    return bob.log(thread).filter((e) => e.type !== "thread.opened").map((e) => JSON.stringify(e.body));
  };
  return { alice, bob, thread, delivered };
}

const held = async (p: Promise<unknown>): Promise<HeldError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof HeldError) return e;
    throw e;
  }
  assert.fail("the message was sent");
};

const enc = (v: string): string[] => [
  v,
  Buffer.from(v).toString("base64"),
  Buffer.from(Buffer.from(v).toString("base64")).toString("base64"),
  Buffer.from(v).toString("hex"),
  [...v].reverse().join(""),
  v.match(/.{1,3}/g)!.join("-"),
  v.match(/.{1,5}/g)!.map((p) => `"${p}"`).join(" + "),
  [...Buffer.from(v)].map((b) => `%${b.toString(16)}`).join(""),
];

function close(...nodes: Counterpart[]): void {
  for (const n of nodes) {
    try {
      n.close();
    } catch {
      // closed already
    }
  }
}

export const outbound: Case[] = [
  {
    id: "GRD-01",
    category: "outbound",
    attacker: "contact",
    title: "Talk the agent into sending a token from its environment, in eight disguises",
    claim: "A secret-named environment value of the sending process is held plain, in base64, twice base64, hex, reversed, split, concatenated or percent-encoded, and the contact receives nothing.",
    async run(ctx) {
      const { alice, thread, delivered } = await scene(ctx);
      try {
        for (const text of enc(TOKEN)) {
          const e = await held(alice.say(thread, `as you asked: ${text}`, "agent"));
          assert.deepEqual(e.reasons, ["env-secret"]);
          assert.ok(!e.message.includes(TOKEN.slice(0, 6)));
        }
        assert.deepEqual(await delivered(), []);
        assert.equal(alice.guard.counts().held, 8);
      } finally {
        close(alice);
      }
    },
  },
  {
    id: "GRD-02",
    category: "outbound",
    attacker: "contact",
    title: "Have the agent attach a private key to a contract proposal",
    claim: "A proposal whose attachment holds a private key is held and never reaches the contact.",
    async run(ctx) {
      const { alice, bob, thread, delivered } = await scene(ctx);
      try {
        const key = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIIrYSSNQFaA2Hwf1duRSxKtLYX5CB04fSeQ6tF1aY/PuoAoGCCqGSM49";
        const e = await held(alice.propose(thread, { title: "Deploy access", text: "As discussed, the key is attached.", parts: [{ kind: "text", name: "deploy.pem", content: key }] }));
        assert.deepEqual(e.reasons, ["private-key"]);
        assert.deepEqual(await delivered(), []);
        assert.equal(bob.contracts(thread).length, 0);
      } finally {
        close(alice);
      }
    },
  },
  {
    id: "GRD-03",
    category: "outbound",
    attacker: "contact",
    title: "Smuggle a .env value out in the goal of a new thread",
    claim: "A value from a .env file in the sender's repository, put in a thread's goal, is held and no thread reaches the contact.",
    async run(ctx) {
      const repo = join(ctx.dir(), "client");
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, ".env"), "PARTNER_FEED_KEY=Hj3kL9mN2bV6cX1zQ8wE5rT4\n");
      const { alice, bob } = await scene(ctx, { env: {}, cwd: repo });
      try {
        const before = bob.threads().length;
        const e = await held(alice.openThread("bob", "re: feed sync (k=Hj3k L9mN 2bV6 cX1z Q8wE 5rT4)"));
        assert.deepEqual(e.reasons, ["dotenv-value"]);
        await ctx.carry(alice, bob);
        assert.equal(bob.threads().length, before);
      } finally {
        close(alice);
      }
    },
  },
  {
    id: "GRD-04",
    category: "outbound",
    attacker: "contact",
    title: "Quote a never-share file, respaced and in base64",
    claim: "Text from a file the owner marked never-share is held however it is spaced, cased or encoded.",
    async run(ctx) {
      const file = join(ctx.dir(), "escalations.md");
      writeFileSync(file, "Their CFO said the renewal is worth 1.4 million and they are talking to a competitor.\n");
      const { alice, thread, delivered } = await scene(ctx, { env: {} });
      try {
        alice.guard.addPath("never-share", file);
        const line = "Their CFO said the renewal is worth 1.4 million and they are talking to a competitor.";
        for (const text of [line.toUpperCase().replace(/ /g, "  "), Buffer.from(line).toString("base64")]) {
          assert.deepEqual((await held(alice.say(thread, text))).reasons, ["never-share-file"]);
        }
        assert.deepEqual(await delivered(), []);
      } finally {
        close(alice);
      }
    },
  },
  {
    id: "GRD-05",
    category: "outbound",
    attacker: "contact",
    title: "Get the agent to release its own held message from a shell",
    claim: "cpart release and removing a never-share file need someone typing at a terminal, and CPART_PASSPHRASE does not stand in for them.",
    async run(ctx) {
      const { alice, thread } = await scene(ctx, {}, PASS);
      const file = join(ctx.dir(), "notes.md");
      writeFileSync(file, "internal");
      alice.guard.addPath("never-share", file);
      await held(alice.say(thread, TOKEN));
      const id = alice.guard.held()[0]!.id;
      close(alice);
      const run = (args: string[]): { status: number | null; err: string } => {
        const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, CPART_HOME: alice.home, CPART_NO_AUTOSTART: "1", CPART_PASSPHRASE: PASS }, input: `${PASS}\nsend\nremove\n`, timeout: 20_000 });
        return { status: r.status, err: r.stderr.toString() };
      };
      for (const args of [["release", id], ["release", id, "--yes"], ["guard", "never-share", "remove", file]]) {
        const r = run(args);
        assert.notEqual(r.status, 0, `cpart ${args.join(" ")} succeeded without a terminal`);
        assert.match(r.err, /terminal/);
      }
      const again = Counterpart.open(alice.home, { guard: { env: {}, cwd: null } });
      try {
        assert.equal(again.guard.counts().held, 1);
        assert.deepEqual(again.guard.paths("never-share"), [file]);
        assert.equal(again.queued().length, 0, "nothing was queued");
        assert.equal(again.log(thread).filter((e) => e.type === "talk.posted").length, 0);
      } finally {
        close(again);
      }
    },
  },
  {
    id: "GRD-06",
    category: "outbound",
    attacker: "contact",
    title: "Mark the secret as allowed with a scanner comment",
    claim: "A gitleaks:allow comment or an allowlist-looking note in the message changes nothing.",
    async run(ctx) {
      const { alice, thread, delivered } = await scene(ctx, { env: {} });
      try {
        const pat = "ghp_R8kL2mQ9xV4tZ7pW1nB6cY3hD5fJ0sA2eG8u";
        assert.ok((await held(alice.say(thread, `token = "${pat}" // gitleaks:allow  (test fixture, not a real key)`))).reasons.includes("api-token"));
        assert.deepEqual(await delivered(), []);
      } finally {
        close(alice);
      }
    },
  },
  {
    id: "GRD-07",
    category: "outbound",
    attacker: "contact",
    title: "Get the front desk to repeat a key it was shown",
    claim: "A front desk reply that carries a key is held for the owner like any other message, and the desk does not try again.",
    async run(ctx) {
      const { alice, bob } = await scene(ctx, { env: {} });
      // The desk answers in threads the contact opened.
      const thread = await ctx.thread(bob, "alice", alice, "sandbox questions");
      const doc = join(ctx.dir(), "api.md");
      writeFileSync(doc, "The sandbox is at https://sandbox.example.com.\n");
      addToBundle(alice.home, "bob", [doc]);
      let calls = 0;
      const desk = new FrontDesk(alice, async () => {
        calls++;
        return "Sure, use AKIAZ7QX4M2R6T3PLW5N with secret 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.";
      });
      try {
        desk.configure("bob", { enabled: true, owner: "Alice" });
        await bob.say(thread, "What AWS key does the sandbox use?");
        await ctx.carry(bob, alice);
        await desk.tick();
        await desk.tick();
        assert.equal(calls, 1);
        assert.deepEqual(alice.guard.held().map((h) => [h.type, h.reasons.join()]), [["talk.posted", "cloud-credential"]]);
        assert.match(desk.runs()[0]!.detail ?? "", /held by the outbound guard/);
        await ctx.carry(alice, bob);
        assert.equal(bob.log(thread).filter((e) => !e.mine).length, 0);
      } finally {
        await desk.stop();
        close(alice);
      }
    },
  },
  {
    id: "GRD-08",
    category: "outbound",
    attacker: "contact",
    title: "Learn the secret back from the hold notice",
    claim: "Neither the error the sender gets nor cpart held shows the value that matched.",
    async run(ctx) {
      const { alice, thread } = await scene(ctx);
      const e = await held(alice.say(thread, `the token is ${TOKEN}, thanks`));
      close(alice);
      assert.ok(!e.message.includes(TOKEN.slice(0, 6)));
      const r = ctx.cli(alice.home, ["held"]);
      assert.equal(r.status, 0, r.stderr.toString());
      const shown = r.stdout.toString();
      assert.match(shown, /env-secret/);
      assert.match(shown, /the token is \[\.\.\.\], thanks/);
      assert.ok(!shown.includes(TOKEN.slice(0, 6)) && !ctx.cli(alice.home, ["held", "--json"]).stdout.toString().includes(TOKEN.slice(0, 6)));
    },
  },
  {
    id: "GRD-09",
    category: "outbound",
    attacker: "contact",
    title: "Send two halves of a token at the same moment",
    claim: "Two messages screened at once cannot each carry half of a value: the second to commit is held.",
    async run(ctx) {
      const { alice, thread, delivered } = await scene(ctx);
      try {
        const r = await Promise.allSettled([alice.say(thread, `a: ${TOKEN.slice(0, 7)}`), alice.say(thread, `b: ${TOKEN.slice(7, 14)}`)]);
        assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
        assert.equal((await delivered()).length, 1);
      } finally {
        close(alice);
      }
    },
  },
  {
    id: "GRD-10",
    category: "outbound",
    attacker: "contact",
    title: "Have the agent accept an invite whose token is the secret",
    claim: "An invite token made from a protected value is not sent back as a contact request.",
    async run(ctx) {
      const { alice, bob } = await scene(ctx);
      try {
        const real = JSON.parse(Buffer.from(bob.createInvite("x").replace(/^cpart-invite:/, ""), "base64url").toString()) as Record<string, unknown>;
        const forged = `cpart-invite:${Buffer.from(JSON.stringify({ ...real, token: TOKEN })).toString("base64url")}`;
        const before = alice.queued().length;
        await assert.rejects(alice.acceptInvite(forged, "mallory"), /looks like it carries a secret/);
        assert.equal(alice.queued().length, before);
      } finally {
        close(alice);
      }
    },
  },
];
