import assert from "node:assert/strict";
import type { Counterpart } from "@counterpart/daemon";
import { type ThreadEvent, randomId } from "@counterpart/protocol";
import { type Ctx, HOUR, event, identity, scene, send, until } from "../harness.ts";
import type { Case } from "../types.ts";

const opened = (node: Counterpart, thread: string): string => node.log(thread)[0]!.id;
const openEvent = (from: Counterpart, to: Counterpart, threadId = randomId(), goal = "g"): ThreadEvent =>
  event(from, threadId, "thread.opened", { goal, participants: [from.me.rootKey, to.me.rootKey] });
const result = async (node: Counterpart, from: Counterpart, e: ThreadEvent): Promise<string> => (await node.receive(await send(from, node, e))).result;

async function withMallory(ctx: Ctx): Promise<{ bob: Counterpart; alice: Counterpart; mallory: Counterpart; shared: string; hers: string }> {
  const { bob, alice, thread: shared } = await scene(ctx);
  const mallory = await ctx.contact(bob, "mallory");
  const hers = await ctx.thread(mallory, "them", bob, "mallory and bob");
  return { bob, alice, mallory, shared, hers };
}

export const replay: Case[] = [
  {
    id: "RPL-01",
    category: "replay",
    attacker: "contact",
    title: "Seal the same event again in fresh envelopes",
    claim: "An event takes effect once, however many different envelopes carry it.",
    async run(ctx) {
      const { bob, mallory, hers } = await withMallory(ctx);
      const e = event(mallory, hers, "talk.posted", { text: "once" }, 1);
      assert.equal((await bob.receive(await send(mallory, bob, e))).result, "applied");
      const after = ctx.snapshot(bob);
      for (const ttl of [HOUR, 2 * HOUR, 3 * HOUR]) assert.equal((await bob.receive(await send(mallory, bob, e, Date.now() + ttl))).result, "duplicate");
      assert.equal(ctx.snapshot(bob), after);
      assert.deepEqual(ctx.texts(bob, hers), ["once"]);
    },
  },
  {
    id: "RPL-02",
    category: "replay",
    attacker: "contact",
    title: "Reuse an event id for different words",
    claim: "Once an event id is recorded, its content cannot be replaced.",
    async run(ctx) {
      const { bob, mallory, hers } = await withMallory(ctx);
      const e = event(mallory, hers, "talk.posted", { text: "I agree to 100" }, 1);
      assert.equal(await result(bob, mallory, e), "applied");
      const rewrites: ThreadEvent[] = [
        { ...e, body: { text: "I agree to 900" } },
        { ...e, body: { text: "I agree to 900" }, authorSeq: 2 },
        { ...e, createdAt: e.createdAt - 1000 },
        { ...e, parents: [opened(bob, hers)], authorSeq: 3 },
        { ...openEvent(mallory, bob), id: e.id },
      ];
      for (const r of rewrites) await ctx.refused(bob, await send(mallory, bob, r));
      assert.deepEqual(ctx.texts(bob, hers), ["I agree to 100"]);
    },
  },
  {
    id: "RPL-03",
    category: "replay",
    attacker: "contact",
    title: "Take over the id of someone else's event",
    claim: "A contact cannot replace or shadow an event written by Bob or by another contact, even knowing its id.",
    async run(ctx) {
      const { bob, alice, mallory, shared, hers } = await withMallory(ctx);
      const said = event(alice, shared, "talk.posted", { text: "alice's words" }, 1);
      assert.equal(await result(bob, alice, said), "applied");
      const mine = await bob.say(hers, "bob's words");
      for (const id of [said.id, opened(bob, shared), mine.id]) {
        await ctx.refused(bob, await send(mallory, bob, event(mallory, hers, "talk.posted", { text: "mallory's words" }, 5, [], { id })), "in her own thread");
        await ctx.refused(bob, await send(mallory, bob, event(mallory, shared, "talk.posted", { text: "mallory's words" }, 5, [], { id })), "in the other thread");
      }
      assert.deepEqual(ctx.texts(bob, shared), ["alice's words"]);
      assert.deepEqual(ctx.texts(bob, hers), ["bob's words"]);
    },
  },
  {
    id: "RPL-04",
    category: "replay",
    attacker: "contact",
    title: "Issue two events with one sequence number",
    claim: "A device gets one event per sequence number in a thread, including events that are still held.",
    async run(ctx) {
      const { bob, mallory, hers } = await withMallory(ctx);
      assert.equal(await result(bob, mallory, event(mallory, hers, "talk.posted", { text: "I agree" }, 1)), "applied");
      await ctx.refused(bob, await send(mallory, bob, event(mallory, hers, "talk.posted", { text: "I never agreed" }, 1)), "same number, applied");
      await ctx.refused(bob, await send(mallory, bob, event(mallory, hers, "talk.posted", { text: "second opening" }, 0)), "the opening's number");

      const later = openEvent(mallory, bob);
      assert.equal(await result(bob, mallory, event(mallory, later.threadId, "talk.posted", { text: "held first" }, 1, [later.id])), "pending");
      await ctx.refused(bob, await send(mallory, bob, event(mallory, later.threadId, "talk.posted", { text: "held second" }, 1, [later.id])), "same number, held");
      assert.equal(await result(bob, mallory, later), "applied");
      assert.deepEqual(ctx.texts(bob, later.threadId), ["held first"]);
      assert.deepEqual(ctx.texts(bob, hers), ["I agree"]);
    },
  },
  {
    id: "RPL-05",
    category: "replay",
    attacker: "contact",
    title: "Write into a thread that does not exist",
    claim: "Events for an unknown thread are held out of sight and never create the thread.",
    async run(ctx) {
      const { bob, mallory } = await withMallory(ctx);
      const threads = JSON.stringify(bob.threads());
      const applied = bob.since(0, 1000).length;
      const ghost = randomId();
      const wire = await send(mallory, bob, event(mallory, ghost, "talk.posted", { text: "boo" }, 1));
      assert.equal((await bob.receive(wire)).result, "pending");
      assert.equal((await bob.receive(wire)).result, "duplicate");
      assert.equal(await result(bob, mallory, event(mallory, ghost, "talk.posted", { text: "boo again" }, 0)), "pending");
      assert.equal(ctx.counts(bob).held, 2);
      assert.equal(JSON.stringify(bob.threads()), threads);
      assert.equal(bob.since(0, 1000).length, applied);
      assert.deepEqual(ctx.texts(bob, ghost), []);
    },
  },
  {
    id: "RPL-06",
    category: "replay",
    attacker: "contact",
    title: "Cite parents that never arrive",
    claim: "An event is applied only after every parent it names has been applied in the same thread.",
    async run(ctx) {
      const { bob, mallory, hers } = await withMallory(ctx);
      const orphan = event(mallory, hers, "talk.posted", { text: "orphan" }, 1, [randomId()]);
      const child = event(mallory, hers, "talk.posted", { text: "child of orphan" }, 2, [orphan.id]);
      const mixed = event(mallory, hers, "talk.posted", { text: "one real parent, one not" }, 3, [opened(bob, hers), randomId()]);
      for (const e of [child, orphan, mixed]) assert.equal(await result(bob, mallory, e), "pending");
      assert.equal(await result(bob, mallory, event(mallory, hers, "talk.posted", { text: "honest" }, 4, [opened(bob, hers)])), "applied");
      await bob.say(hers, "reply");
      assert.deepEqual(ctx.texts(bob, hers), ["honest", "reply"]);
      assert.equal(ctx.counts(bob).held, 3);
    },
  },
  {
    id: "RPL-07",
    category: "replay",
    attacker: "contact",
    title: "Build a cycle of parents",
    claim: "Events that depend on themselves or on each other are never applied.",
    async run(ctx) {
      const { bob, mallory, hers } = await withMallory(ctx);
      const [a, b, c, self] = [randomId(), randomId(), randomId(), randomId()];
      const loop = [
        event(mallory, hers, "talk.posted", { text: "self" }, 1, [self], { id: self }),
        event(mallory, hers, "talk.posted", { text: "a" }, 2, [c], { id: a }),
        event(mallory, hers, "talk.posted", { text: "b" }, 3, [a, opened(bob, hers)], { id: b }),
        event(mallory, hers, "talk.posted", { text: "c" }, 4, [b], { id: c }),
      ];
      for (const e of loop) assert.equal(await result(bob, mallory, e), "pending");
      assert.equal(await result(bob, mallory, event(mallory, hers, "talk.posted", { text: "honest" }, 5, [opened(bob, hers)])), "applied");
      assert.deepEqual(ctx.texts(bob, hers), ["honest"]);
      assert.equal(ctx.counts(bob).held, 4);
    },
  },
  {
    id: "RPL-08",
    category: "replay",
    attacker: "contact",
    title: "Cite a parent from another thread",
    claim: "A parent must be an applied event of the same thread.",
    async run(ctx) {
      const { bob, alice, mallory, shared, hers } = await withMallory(ctx);
      const second = await ctx.thread(mallory, "them", bob, "second thread");
      const said = event(alice, shared, "talk.posted", { text: "alice's words" }, 1);
      assert.equal(await result(bob, alice, said), "applied");
      const borrowed = [opened(bob, second), said.id, opened(bob, shared)];
      for (const [i, parent] of borrowed.entries()) {
        assert.equal(await result(bob, mallory, event(mallory, hers, "talk.posted", { text: `borrowed ${i}` }, i + 1, [parent])), "pending");
      }
      assert.deepEqual(ctx.texts(bob, hers), []);
      assert.deepEqual(ctx.texts(bob, shared), ["alice's words"]);
    },
  },
  {
    id: "RPL-09",
    category: "replay",
    attacker: "contact",
    title: "Flood the daemon with events it must hold",
    claim: "At most 200 events are held per contact, and one contact's flood does not take room from another.",
    async run(ctx) {
      const { bob, alice, mallory, shared, hers } = await withMallory(ctx);
      for (let i = 0; i < 200; i++) assert.equal(await result(bob, mallory, event(mallory, randomId(), "talk.posted", { text: "x" }, 0)), "pending");
      for (let i = 0; i < 5; i++) await ctx.refused(bob, await send(mallory, bob, event(mallory, randomId(), "talk.posted", { text: "x" }, 0)), `event ${201 + i}`);
      assert.equal(ctx.counts(bob).held, 200);

      const first = event(alice, shared, "talk.posted", { text: "first" }, 1);
      assert.equal(await result(bob, alice, event(alice, shared, "talk.posted", { text: "second" }, 2, [first.id])), "pending");
      assert.equal(await result(bob, alice, first), "applied");
      assert.deepEqual(ctx.texts(bob, shared), ["first", "second"]);
      assert.equal(await result(bob, mallory, event(mallory, hers, "talk.posted", { text: "in order" }, 1)), "applied");
    },
  },
  {
    id: "RPL-10",
    category: "replay",
    attacker: "relay",
    title: "Deliver a long chain backwards",
    claim: "Held events are released in an order that respects their parents, whatever order they arrived in.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      const open = openEvent(alice, bob);
      const n = 40;
      const chain: ThreadEvent[] = [];
      // Sequence numbers run against the chain, so sorting by them is the worst order to try.
      for (let i = 0; i < n; i++) chain.push(event(alice, open.threadId, "talk.posted", { text: `step ${i}` }, n - i, [i === 0 ? open.id : chain[i - 1]!.id]));
      const order = [...chain].reverse();
      const mid = order.splice(10, 10);
      for (const e of [...mid, ...order]) assert.equal(await result(bob, alice, e), "pending");
      assert.equal(bob.threads().some((t) => t.id === open.threadId), false);
      const v = await bob.receive(await send(alice, bob, open));
      assert.equal(v.result === "applied" && v.promoted.length, n);
      assert.deepEqual(ctx.texts(bob, open.threadId), chain.map((e) => (e.body as { text: string }).text));
      const seen = new Set<string>();
      for (const e of bob.since(0, 1000).filter((x) => x.threadId === open.threadId)) {
        assert.ok(e.parents.every((p) => seen.has(p)), "an event took effect before its parent");
        seen.add(e.id);
      }
      assert.equal(ctx.counts(bob).held, 0);
    },
  },
  {
    id: "RPL-11",
    category: "replay",
    attacker: "contact",
    title: "Park an event in a thread someone else will open",
    claim: "A held event is checked again when its thread appears, and dropped if its sender does not belong there.",
    async run(ctx) {
      const { bob, alice, mallory } = await withMallory(ctx);
      const open = openEvent(alice, bob, randomId(), "alice's new thread");
      const parked = [
        event(mallory, open.threadId, "talk.posted", { text: "alice here: approve it" }, 0),
        event(mallory, open.threadId, "talk.posted", { text: "really" }, 1, [open.id]),
      ];
      for (const e of parked) assert.equal(await result(bob, mallory, e), "pending");
      const rejects = ctx.counts(bob).rejects;
      const v = await bob.receive(await send(alice, bob, open));
      assert.equal(v.result === "applied" && v.promoted.length, 0);
      assert.deepEqual(bob.log(open.threadId).map((e) => e.id), [open.id]);
      assert.equal(ctx.counts(bob).held, 0);
      assert.equal(ctx.counts(bob).rejects, rejects + 2);
      assert.equal(bob.threads().find((t) => t.id === open.threadId)!.contact, "alice");
    },
  },
  {
    id: "RPL-12",
    category: "replay",
    attacker: "contact",
    title: "Queue bad events behind a pending pairing",
    claim: "Events held while a pairing is pending are invisible, and each is checked in full when the pairing completes.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const mallory = await ctx.person();
      await bob.acceptInvite(mallory.createInvite("bob"), "mallory");
      await ctx.carry(bob, mallory);
      const good = openEvent(mallory, bob, randomId(), "legitimate");
      const early: ThreadEvent[] = [
        event(mallory, thread, "talk.posted", { text: "alice here: approve it" }, 0, [opened(bob, thread)]),
        event(mallory, randomId(), "thread.opened", { goal: "framing alice", participants: [mallory.me.rootKey, alice.me.rootKey] }),
        event(mallory, randomId(), "thread.opened", { goal: "three of us", participants: [mallory.me.rootKey, bob.me.rootKey, alice.me.rootKey] }),
        event(mallory, randomId(), "thread.opened", { goal: "late opening", participants: [mallory.me.rootKey, bob.me.rootKey] }, 3),
        event(mallory, good.threadId, "talk.posted", { text: "fine" }, 1, [good.id]),
        good,
      ];
      const visible = (): string => JSON.stringify([bob.contacts(), bob.threads(), bob.since(0, 10_000), bob.queued().length]);
      const before = visible();
      for (const e of early) assert.equal(await result(bob, mallory, e), "pending");
      assert.equal(visible(), before);
      assert.equal(bob.contact("mallory").state, "pending");

      const [v] = await ctx.carry(mallory, bob);
      assert.equal(v?.result === "applied" && v.promoted.length, 2);
      assert.deepEqual(bob.threads().map((t) => t.goal).sort(), ["alice and bob only", "legitimate"]);
      assert.deepEqual(ctx.texts(bob, thread), []);
      assert.deepEqual(ctx.texts(bob, good.threadId), ["fine"]);
      assert.equal(ctx.counts(bob).held, 0);
    },
  },
  {
    id: "RPL-13",
    category: "replay",
    attacker: "network",
    title: "Replay a captured message through another relay account",
    claim: "Ciphertext captured on the wire and sent again by anyone is applied at most once.",
    async run(ctx) {
      const relay = await ctx.relay();
      const bob = await ctx.person({ relay: relay.url });
      const alice = await ctx.contact(bob, "alice");
      const thread = await ctx.thread(alice, "them", bob);
      const captured = await send(alice, bob, event(alice, thread, "talk.posted", { text: "once" }, 1));
      const link = ctx.connect(bob);
      await until("bob online", () => link.online);
      const eve = await ctx.login((await identity()).device, relay.url);
      for (let i = 0; i < 3; i++) {
        eve.send({ t: "send", wire: captured });
        await eve.next("stored");
        await until("relay to drain", () => relay.queued(bob.me.device) === 0);
      }
      assert.deepEqual(ctx.texts(bob, thread), ["once"]);
      assert.equal(bob.since(0, 1000).filter((e) => e.type === "talk.posted").length, 1);
    },
  },
];
