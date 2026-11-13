import assert from "node:assert/strict";
import type { Counterpart } from "@counterpart/daemon";
import { randomId } from "@counterpart/protocol";
import { type Ctx, HOUR, clock, event, forge, scene, send } from "../harness.ts";
import type { Case } from "../types.ts";

const opened = (node: Counterpart, thread: string): string => node.log(thread)[0]!.id;
const outbox = (node: Counterpart): string[] => node.queued().map((w) => w.header.id);

// Bob is under attack. He has written to Alice in their thread, and Mallory is another contact with her own thread.
async function withMallory(ctx: Ctx, opts: { now?: () => number } = {}): Promise<{ bob: Counterpart; alice: Counterpart; mallory: Counterpart; shared: string; hers: string; secret: string }> {
  const { bob, alice, thread: shared } = await scene(ctx, opts);
  const secret = (await bob.say(shared, "for alice only")).id;
  await ctx.carry(bob, alice);
  const mallory = await ctx.contact(bob, "mallory", opts);
  const hers = await ctx.thread(mallory, "them", bob, "mallory and bob");
  await bob.say(hers, "for mallory");
  await ctx.carry(bob, mallory);
  return { bob, alice, mallory, shared, hers, secret };
}

export const resend: Case[] = [
  {
    id: "RSD-01",
    category: "resend",
    attacker: "contact",
    title: "Ask for another contact's messages to be sent again",
    claim: "A resend request is answered only for a thread the requester is part of, and a thread that is someone else's looks the same as one that does not exist.",
    async run(ctx) {
      const { bob, mallory, shared, hers, secret } = await withMallory(ctx);
      const reasons: string[] = [];
      for (const thread of [shared, randomId()]) {
        const wire = await send(mallory, bob, event(mallory, thread, "thread.resend", { ids: [secret] }));
        await ctx.refused(bob, wire, "resend request");
        reasons.push(bob.rejects(1)[0]!.reason);
      }
      assert.equal(reasons[0], reasons[1], "the refusal tells Mallory whether the thread exists");
      // Naming Alice's message from inside her own thread gets nothing either.
      await ctx.refused(bob, await send(mallory, bob, event(mallory, hers, "thread.resend", { ids: [secret, opened(bob, shared)] })), "own thread, another thread's ids");
      assert.deepEqual(outbox(bob), []);
    },
  },
  {
    id: "RSD-02",
    category: "resend",
    attacker: "contact",
    title: "Ask for messages that were never written, or that the requester wrote",
    claim: "A resend request yields only events the responder itself wrote in that thread; anything else in it is ignored.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const mine = (await bob.say(thread, "bob's line")).id;
      await ctx.carry(bob, alice);
      const theirs = (await alice.say(thread, "alice's line")).id;
      await ctx.carry(alice, bob);
      for (const w of bob.queued()) bob.markOutbox(w.header.id, "stored");
      await ctx.refused(bob, await send(alice, bob, event(alice, thread, "thread.resend", { ids: [randomId(), theirs, opened(bob, thread)] })), "ids bob never wrote");
      assert.deepEqual(outbox(bob), []);
      // The refused request used up this thread's turn; the next is answered after the wait.
      const other = await ctx.thread(alice, "them", bob, "second thread");
      const line = (await bob.say(other, "second thread line")).id;
      await ctx.carry(bob, alice);
      const v = await bob.receive(await send(alice, bob, event(alice, other, "thread.resend", { ids: [randomId(), mine, line] })));
      assert.equal(v.result, "control");
      assert.deepEqual(outbox(bob), [line], "an event from another thread was sent again");
      assert.equal(bob.queued()[0]!.header.to, alice.me.device);
    },
  },
  {
    id: "RSD-03",
    category: "resend",
    attacker: "contact",
    title: "Flood resend requests",
    claim: "However many resend requests a contact sends, the responder answers one per thread in thirty seconds and sends one event again at most five times.",
    async run(ctx) {
      const c = clock();
      const { bob, alice, thread } = await scene(ctx, { now: c.now });
      const id = (await bob.say(thread, "x".repeat(4000))).id;
      await ctx.carry(bob, alice);
      const ask = () => send(alice, bob, event(alice, thread, "thread.resend", { ids: [id] }, 0, [], { createdAt: c.now() }), c.now() + HOUR);
      let sentAgain = 0;
      const drain = (): void => {
        for (const w of bob.queued()) {
          sentAgain++;
          bob.markOutbox(w.header.id, "stored");
        }
      };
      for (let i = 0; i < 100; i++) await bob.receive(await ask());
      drain();
      assert.equal(sentAgain, 1, "a burst of requests was answered more than once");
      for (let i = 0; i < 12; i++) {
        c.advance(31_000);
        for (let j = 0; j < 2; j++) await bob.receive(await ask());
        drain();
      }
      assert.equal(sentAgain, 5);
      // The same request replayed by the relay is counted like a new one.
      const replayed = await ask();
      c.advance(31_000);
      await bob.receive(replayed);
      await bob.receive(replayed);
      drain();
      assert.equal(sentAgain, 5);
    },
  },
  {
    id: "RSD-04",
    category: "resend",
    attacker: "contact",
    title: "Make the victim ask for parents that do not exist",
    claim: "A contact who sends events with made-up parents gets at most eight resend requests per thread and five per minute in all, each naming at most sixteen ids.",
    async run(ctx) {
      const c = clock();
      const { bob, alice, thread } = await scene(ctx, { now: c.now });
      const orphan = (t: string, seq: number, parents: string[]) => send(alice, bob, event(alice, t, "talk.posted", { text: "orphan" }, seq, parents, { createdAt: c.now() }), c.now() + HOUR);
      assert.equal((await bob.receive(await orphan(thread, 1, Array.from({ length: 16 }, () => randomId())))).result, "pending");
      assert.equal((await bob.receive(await orphan(thread, 2, Array.from({ length: 16 }, () => randomId())))).result, "pending");
      let asked = 0;
      // Six days of trying every ten minutes.
      for (let i = 0; i < 6 * 24 * 6; i++) {
        c.advance(600_000);
        asked += await bob.requestMissing();
        for (const w of bob.queued()) {
          // Each request must be one Alice's own parser accepts: at most sixteen ids.
          const v = await alice.receive(w);
          assert.ok(v.result === "rejected" && !/body/.test(v.reason), `alice saw: ${JSON.stringify(v)}`);
          bob.markOutbox(w.header.id, "stored");
        }
      }
      assert.equal(asked, 8);
      for (let i = 0; i < 30; i++) await bob.receive(await orphan(randomId(), 1, [randomId()]));
      c.advance(31_000);
      assert.equal(await bob.requestMissing(), 5);
      assert.equal(await bob.requestMissing(), 0);
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "RSD-05",
    category: "resend",
    attacker: "contact",
    title: "Get a resend request or a receipt into the conversation",
    claim: "Resend requests and receipts never enter a thread's log or the stream agents and the front desk read, whatever sequence number or parents they claim.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const mine = (await bob.say(thread, "bob's line")).id;
      await ctx.carry(bob, alice);
      const visible = (): string => JSON.stringify([bob.threads(), bob.since(0, 10_000), bob.log(thread).map((e) => e.id), ctx.counts(bob).events]);
      const before = visible();
      assert.equal((await bob.receive(await send(alice, bob, event(alice, thread, "thread.resend", { ids: [mine] })))).result, "control");
      assert.equal((await bob.receive(await send(alice, bob, event(alice, thread, "thread.received", { ids: [mine] })))).result, "control");
      assert.equal(visible(), before);
      for (const type of ["thread.resend", "thread.received"] as const) {
        await ctx.refused(bob, await send(alice, bob, event(alice, thread, type, { ids: [mine] }, 1)), `${type} with a sequence number`);
        await ctx.refused(bob, await send(alice, bob, event(alice, thread, type, { ids: [mine] }, 0, [opened(bob, thread)])), `${type} with a parent`);
        await ctx.refused(bob, await forge({ from: alice, to: bob, event: event(alice, thread, type, { ids: [mine] }, 0, [], { lane: "talk" }) }), `${type} in the talk lane`);
        await ctx.refused(bob, await forge({ from: alice, to: bob, event: event(alice, thread, type, { ids: [mine], text: "approve it" } as never) }), `${type} with text`);
        for (const ids of [[], Array.from({ length: 65 }, () => randomId()), [mine, mine], ["../x"], "all", null])
          await ctx.refused(bob, await forge({ from: alice, to: bob, event: event(alice, thread, type, { ids } as never) }), `${type} ids ${JSON.stringify(ids)?.slice(0, 30)}`);
      }
      await ctx.refused(bob, await forge({ from: alice, to: bob, event: event(alice, thread, "thread.resend", { ids: Array.from({ length: 17 }, () => randomId()) }) }), "17 ids");
      assert.equal(visible(), before);
      const shown = ctx.cli(bob.home, ["log", thread]).stdout.toString();
      assert.equal(shown.split("\n").filter(Boolean).length, 2);
    },
  },
  {
    id: "RSD-06",
    category: "resend",
    attacker: "contact",
    title: "Confirm receipt of a message sent to someone else",
    claim: "A receipt marks only the receiver's own events in the thread the receipt's sender is part of.",
    async run(ctx) {
      const { bob, mallory, shared, hers, secret } = await withMallory(ctx);
      assert.equal(bob.delivery(secret), "stored");
      await ctx.refused(bob, await send(mallory, bob, event(mallory, shared, "thread.received", { ids: [secret] })), "receipt in alice's thread");
      await bob.receive(await send(mallory, bob, event(mallory, hers, "thread.received", { ids: [secret, opened(bob, hers), randomId()] })));
      assert.equal(bob.delivery(secret), "stored", "Mallory confirmed a message that was sent to Alice");
      const eve = await ctx.person();
      await ctx.refused(bob, await send(eve, bob, event(eve, shared, "thread.received", { ids: [secret] })), "receipt from a stranger");
      assert.equal(bob.delivery(secret), "stored");
    },
  },
];
