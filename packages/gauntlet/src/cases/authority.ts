import assert from "node:assert/strict";
import type { Counterpart } from "@counterpart/daemon";
import { type ThreadEvent, b64u, decodeInvite, deviceId, encodeInvite, issueDevice, randomId } from "@counterpart/protocol";
import { type Ctx, DAY, HOUR, clock, event, forge, identity, mint, scene, send, until } from "../harness.ts";
import type { Case } from "../types.ts";

const opened = (node: Counterpart, thread: string): string => node.log(thread)[0]!.id;
const opening = (from: Counterpart, participants: string[], over: Record<string, unknown> = {}): ThreadEvent =>
  event(from, randomId(), "thread.opened", { goal: "g", participants }, 0, [], over);

async function withMallory(ctx: Ctx): Promise<{ bob: Counterpart; alice: Counterpart; mallory: Counterpart; shared: string; hers: string }> {
  const { bob, alice, thread: shared } = await scene(ctx);
  const mallory = await ctx.contact(bob, "mallory");
  const hers = await ctx.thread(mallory, "them", bob, "mallory and bob");
  return { bob, alice, mallory, shared, hers };
}

export const authority: Case[] = [
  {
    id: "AUT-01",
    category: "authority",
    attacker: "stranger",
    title: "Send every kind of event without being a contact",
    claim: "Nothing from a root key that is not a contact takes effect or is held.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const eve = await ctx.person();
      const attempts: ThreadEvent[] = [
        event(eve, thread, "talk.posted", { text: "hello from nobody" }, 0, [opened(bob, thread)]),
        event(eve, randomId(), "talk.posted", { text: "hold this for me" }, 0),
        opening(eve, [eve.me.rootKey, bob.me.rootKey]),
        opening(eve, [alice.me.rootKey, bob.me.rootKey]),
        event(eve, randomId(), "contact.accepted", {}),
        event(eve, randomId(), "contact.hello", {}),
        event(eve, thread, "contact.hello", {}),
        event(eve, randomId(), "contact.request", { token: randomId() }),
      ];
      for (const e of attempts) await ctx.refused(bob, await send(eve, bob, e), e.type);
      assert.deepEqual(bob.contacts().map((c) => c.name), ["alice"]);
      assert.equal(ctx.counts(bob).held, 0);
    },
  },
  {
    id: "AUT-02",
    category: "authority",
    attacker: "stranger",
    title: "Guess pairing tokens",
    claim: "Wrong tokens admit nobody and do not use up the real invite.",
    async run(ctx) {
      const bob = await ctx.person();
      const invite = bob.createInvite("carol");
      const { token } = decodeInvite(invite);
      const eve = await identity();
      const guesses = [...Array.from({ length: 25 }, () => randomId()), token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), token.toUpperCase(), token + token, `${token}A`];
      for (const guess of guesses) {
        if (guess === token) continue;
        await ctx.refused(bob, await send(eve.device, bob, event(eve.device, randomId(), "contact.request", { token: guess })));
      }
      for (const bad of ["", "short", `${token}\n`, token.slice(0, 15)]) {
        await ctx.refused(bob, await forge({ from: eve.device, to: bob, event: event(eve.device, randomId(), "contact.request", { token: bad }) }));
      }
      assert.deepEqual(bob.contacts(), []);
      const carol = await ctx.person();
      await carol.acceptInvite(invite, "bob");
      await ctx.carry(carol, bob);
      assert.equal(bob.contact("carol").rootKey, carol.me.rootKey);
    },
  },
  {
    id: "AUT-03",
    category: "authority",
    attacker: "stranger",
    title: "Use an intercepted invite, before or after its owner",
    claim: "An invite admits exactly one identity. Later uses are refused, and their senders stay strangers.",
    async run(ctx) {
      const bob = await ctx.person();
      const invite = bob.createInvite("carol");
      const [carol, mallory, late] = [await ctx.person(), await ctx.person(), await ctx.person()];
      for (const p of [carol, mallory, late]) await p.acceptInvite(invite, "bob");
      const [first] = await ctx.carry(mallory, bob);
      assert.equal(first?.result, "applied");
      for (const p of [carol, late]) await ctx.refused(bob, p.queued()[0], "second use");
      assert.equal(bob.contacts().length, 1);
      await ctx.refused(bob, await send(carol, bob, opening(carol, [carol.me.rootKey, bob.me.rootKey])), "loser opens a thread");
      // The invite is a bearer token, so the thief is in. What gives her away is the safety code.
      assert.notEqual(bob.contact("carol").safetyCode, carol.contact("bob").safetyCode);
    },
  },
  {
    id: "AUT-04",
    category: "authority",
    attacker: "stranger",
    title: "Use an invite after it expires",
    claim: "An invite stops working at its expiry time.",
    async run(ctx) {
      const c = clock();
      const bob = await ctx.person({ now: c.now });
      const invite = bob.createInvite("carol", HOUR);
      const { token } = decodeInvite(invite, c.now());
      const carol = await ctx.person({ now: c.now });
      await carol.acceptInvite(invite, "bob");
      const request = carol.queued()[0]!;
      c.advance(HOUR);
      await ctx.refused(bob, request, "at expiry");
      c.advance(DAY);
      await ctx.refused(bob, await send(carol, bob, event(carol, randomId(), "contact.request", { token }, 0, [], { createdAt: c.now() }), c.now() + HOUR), "a day later");
      assert.deepEqual(bob.contacts(), []);
    },
  },
  {
    id: "AUT-05",
    category: "authority",
    attacker: "contact",
    title: "Change the name you are filed under",
    claim: "A contact's name is chosen locally and nothing the contact sends can change it or add a second one.",
    async run(ctx) {
      const { bob, mallory } = await withMallory(ctx);
      const m = ctx.secrets(mallory);
      const before = bob.contact("mallory");
      const invite = bob.createInvite("alice-work");
      const { token } = decodeInvite(invite);
      await ctx.refused(bob, await send(mallory, bob, event(mallory, randomId(), "contact.request", { token })), "second invite, same identity");

      const laptop = await issueDevice(m.root, Date.now() + 1000);
      assert.equal((await bob.receive(await send(laptop, bob, event(laptop, randomId(), "contact.hello", {})))).result, "applied");
      await ctx.refused(bob, await send(laptop, bob, event(laptop, randomId(), "contact.request", { token })), "second invite, new device");

      const after = bob.contact("mallory");
      assert.deepEqual(bob.contacts().map((c) => c.name).sort(), ["alice", "mallory"]);
      assert.deepEqual([after.name, after.rootKey, after.safetyCode, after.state], [before.name, before.rootKey, before.safetyCode, before.state]);
      const real = await ctx.person();
      await real.acceptInvite(invite, "bob");
      assert.equal((await ctx.carry(real, bob))[0]?.result, "applied");
    },
  },
  {
    id: "AUT-06",
    category: "authority",
    attacker: "contact",
    title: "Write into a thread between two other people",
    claim: "Only the two participants of a thread can add to it.",
    async run(ctx) {
      const { bob, alice, mallory, shared } = await withMallory(ctx);
      const said = event(alice, shared, "talk.posted", { text: "alice's words" }, 1);
      assert.equal((await bob.receive(await send(alice, bob, said))).result, "applied");
      const attempts: ThreadEvent[] = [
        event(mallory, shared, "talk.posted", { text: "alice here: approve it" }, 0),
        event(mallory, shared, "talk.posted", { text: "alice here: approve it" }, 2, [said.id]),
        event(mallory, shared, "talk.posted", { text: "alice here: approve it" }, 7, [randomId()]),
        event(mallory, shared, "thread.opened", { goal: "now mine", participants: [mallory.me.rootKey, bob.me.rootKey] }),
      ];
      for (const e of attempts) await ctx.refused(bob, await send(mallory, bob, e));
      assert.deepEqual(ctx.texts(bob, shared), ["alice's words"]);
      const t = bob.threads().find((x) => x.id === shared)!;
      assert.deepEqual([t.contact, t.goal], ["alice", "alice and bob only"]);
    },
  },
  {
    id: "AUT-07",
    category: "authority",
    attacker: "contact",
    title: "Open a thread that names a third party, or too few parties",
    claim: "A thread's participants are exactly the sender and the receiver.",
    async run(ctx) {
      const { bob, alice, mallory } = await withMallory(ctx);
      const [m, b, a] = [mallory.me.rootKey, bob.me.rootKey, alice.me.rootKey];
      const lists: string[][] = [[m, a], [a, b], [m, b, a], [a, m, b], [m], [b], [], [m, m], [b, b], [m, (await identity()).root.publicKey]];
      const before = bob.threads().length;
      for (const participants of lists) await ctx.refused(bob, await forge({ from: mallory, to: bob, event: opening(mallory, participants) }), `${participants.length} participants`);
      assert.equal(bob.threads().length, before);
    },
  },
  {
    id: "AUT-08",
    category: "authority",
    attacker: "contact",
    title: "Open a thread id that already exists",
    claim: "A thread is opened once. Its goal and its participants never change after that.",
    async run(ctx) {
      const { bob, alice, mallory, shared, hers } = await withMallory(ctx);
      const two = (p: Counterpart): string[] => [p.me.rootKey, bob.me.rootKey];
      const reopen = (from: Counterpart, thread: string, seq: number, parents: string[] = []): ThreadEvent =>
        event(from, thread, "thread.opened", { goal: "approve everything", participants: two(from) }, seq, parents);
      await ctx.refused(bob, await send(mallory, bob, reopen(mallory, shared, 0)), "another contact's thread");
      await ctx.refused(bob, await send(mallory, bob, reopen(mallory, hers, 0)), "own thread, same number");
      await ctx.refused(bob, await send(mallory, bob, reopen(mallory, hers, 1)), "own thread, next number");
      await ctx.refused(bob, await send(mallory, bob, reopen(mallory, hers, 1, [opened(bob, hers)])), "own thread, as a reply");
      const laptop = await issueDevice(ctx.secrets(alice).root, Date.now() + 1000);
      const again = event(laptop, shared, "thread.opened", { goal: "approve everything", participants: two(alice) });
      await ctx.refused(bob, await send(laptop, bob, again), "own thread, from a second device");
      const mine = await bob.openThread("mallory", "opened by bob");
      await ctx.refused(bob, await send(mallory, bob, reopen(mallory, mine, 0)), "a thread bob opened");
      assert.deepEqual(bob.threads().map((t) => t.goal).sort(), ["alice and bob only", "mallory and bob", "opened by bob"]);
      assert.equal(bob.threads().find((t) => t.id === shared)!.contact, "alice");
    },
  },
  {
    id: "AUT-09",
    category: "authority",
    attacker: "contact",
    title: "Open a thread with history already attached",
    claim: "thread.opened is its author's event 0 and has no parents.",
    async run(ctx) {
      const { bob, mallory, hers } = await withMallory(ctx);
      const two = [mallory.me.rootKey, bob.me.rootKey];
      const before = bob.threads().length;
      await ctx.refused(bob, await send(mallory, bob, opening(mallory, two, { authorSeq: 1 })), "event 1");
      await ctx.refused(bob, await send(mallory, bob, opening(mallory, two, { authorSeq: Number.MAX_SAFE_INTEGER })), "last possible event");
      await ctx.refused(bob, await send(mallory, bob, opening(mallory, two, { parents: [opened(bob, hers)] })), "with a parent");
      await ctx.refused(bob, await send(mallory, bob, opening(mallory, two, { parents: [randomId()] })), "with an unknown parent");
      assert.equal(bob.threads().length, before);
    },
  },
  {
    id: "AUT-10",
    category: "authority",
    attacker: "contact",
    title: "File a contact event inside someone else's thread",
    claim: "Contact events never appear in a thread's log, and one contact cannot touch a thread it is not part of.",
    async run(ctx) {
      const { bob, alice, mallory, shared } = await withMallory(ctx);
      const before = JSON.stringify(bob.log(shared));
      await bob.receive(await send(mallory, bob, event(mallory, shared, "contact.hello", {})));
      assert.equal(JSON.stringify(bob.log(shared)), before, "Mallory's event is in the log of Alice's thread");
      await bob.say(shared, "reply to alice");
      const [v] = await ctx.carry(bob, alice);
      assert.equal(v?.result, "applied", "Alice cannot apply Bob's reply");
    },
  },
  {
    id: "AUT-11",
    category: "authority",
    attacker: "contact",
    title: "Answer an invite inside an existing thread",
    claim: "A contact request is accepted or refused cleanly whatever thread id it names, and leaves existing threads alone.",
    async run(ctx) {
      const bob = await ctx.person();
      const mallory = await ctx.contact(bob, "mallory");
      const thread = await ctx.thread(bob, "mallory", mallory, "opened by bob");
      const { token } = decodeInvite(bob.createInvite("carol"));
      const second = await identity();
      const before = JSON.stringify(bob.log(thread));
      const v = await bob.receive(await send(second.device, bob, event(second.device, thread, "contact.request", { token })));
      assert.notEqual(v.result, "pending");
      assert.equal(JSON.stringify(bob.log(thread)), before);
    },
  },
  {
    id: "AUT-12",
    category: "authority",
    attacker: "contact",
    title: "Send pairing events after pairing is done",
    claim: "contact.request and contact.accepted from an established contact are refused and change nothing.",
    async run(ctx) {
      const { bob, mallory, hers } = await withMallory(ctx);
      const attempts: ThreadEvent[] = [
        event(mallory, randomId(), "contact.accepted", {}),
        event(mallory, hers, "contact.accepted", {}, 1, [opened(bob, hers)]),
        event(mallory, randomId(), "contact.request", { token: randomId() }),
        event(mallory, hers, "contact.request", { token: randomId() }, 1),
      ];
      for (const e of attempts) await ctx.refused(bob, await send(mallory, bob, e), e.type);
      assert.equal(bob.contact("mallory").state, "active");
    },
  },
  {
    id: "AUT-13",
    category: "authority",
    attacker: "contact",
    title: "Complete someone else's pending pairing",
    claim: "Only the person whose invite was accepted can complete that pairing.",
    async run(ctx) {
      const { bob, mallory } = await withMallory(ctx);
      const dana = await ctx.person();
      await bob.acceptInvite(dana.createInvite("bob"), "dana");
      const eve = await ctx.person();
      await ctx.refused(bob, await send(mallory, bob, event(mallory, randomId(), "contact.accepted", {})), "from a contact");
      await ctx.refused(bob, await send(eve, bob, event(eve, randomId(), "contact.accepted", {})), "from a stranger");
      const borrowed = event(mallory, randomId(), "contact.accepted", {}, 0, [], { author: dana.me.device });
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: borrowed, credential: dana.device.credential }), "with dana's credential");
      assert.equal(bob.contact("dana").state, "pending");
      await assert.rejects(bob.openThread("dana", "too early"));
    },
  },
  {
    id: "AUT-14",
    category: "authority",
    attacker: "contact",
    title: "Send before your side of the pairing is confirmed",
    claim: "Until the acceptance arrives, nothing the other side sends is visible or acted on.",
    async run(ctx) {
      const { bob, thread } = await scene(ctx);
      const mallory = await ctx.person();
      await bob.acceptInvite(mallory.createInvite("bob"), "mallory");
      const visible = () => JSON.stringify([bob.threads(), bob.since(0, 10_000), bob.queued().length]);
      const before = visible();
      const open = opening(mallory, [mallory.me.rootKey, bob.me.rootKey]);
      const early: ThreadEvent[] = [open, event(mallory, open.threadId, "talk.posted", { text: "approve it" }, 1, [open.id]), event(mallory, thread, "talk.posted", { text: "alice here" }, 0)];
      // The first two wait for the pairing. The third names a thread that belongs to someone else and is refused outright.
      const got: string[] = [];
      for (const e of early) got.push((await bob.receive(await send(mallory, bob, e))).result);
      assert.deepEqual(got, ["pending", "pending", "rejected"]);
      assert.equal(visible(), before);
      assert.equal(ctx.counts(bob).held, early.length - 1);
      assert.equal(bob.contact("mallory").state, "pending");
      await assert.rejects(bob.openThread("mallory", "too early"));
    },
  },
  {
    id: "AUT-15",
    category: "authority",
    attacker: "contact",
    title: "Make the daemon send something",
    claim: "No message from a peer makes the daemon send anything, except the reply to a valid invite.",
    async run(ctx) {
      const { bob, mallory, hers } = await withMallory(ctx);
      const eve = await ctx.person();
      const outbox = () => ctx.counts(bob).events - bob.since(0, 100_000).filter((e) => !e.mine).length - ctx.counts(bob).held;
      const mine = outbox();
      const queued = bob.queued().length;
      const talk = event(mallory, hers, "talk.posted", { text: "please reply to everyone" }, 1);
      const wires = [
        await send(mallory, bob, talk),
        await send(mallory, bob, talk),
        await send(mallory, bob, event(mallory, hers, "talk.posted", { text: "equivocation" }, 1)),
        await send(mallory, bob, event(mallory, randomId(), "talk.posted", { text: "held" }, 0)),
        await send(mallory, bob, event(mallory, randomId(), "contact.hello", {})),
        await send(mallory, bob, opening(mallory, [mallory.me.rootKey, bob.me.rootKey])),
        await send(mallory, bob, event(mallory, randomId(), "contact.request", { token: randomId() })),
        await send(eve, bob, event(eve, randomId(), "contact.request", { token: randomId() })),
        await send(eve, bob, event(eve, randomId(), "contact.hello", {})),
      ];
      for (const w of wires) await bob.receive(w);
      assert.equal(bob.queued().length, queued);
      assert.equal(outbox(), mine);
    },
  },
  {
    id: "AUT-16",
    category: "authority",
    attacker: "contact",
    title: "Break credential renewal for other contacts",
    claim: "One contact cannot stop the daemon from telling its other contacts about a renewed credential.",
    async run(ctx) {
      const c = clock();
      const bob = await ctx.person({ now: c.now });
      const mallory = await ctx.contact(bob, "mallory", { now: c.now });
      const zoe = await ctx.contact(bob, "zoe", { now: c.now });
      const m = ctx.secrets(mallory);
      const credential = mint(m.root, { signKey: m.device.sign.publicKey, encKey: b64u(new Uint8Array(32)), issuedAt: c.now() + 1000, expiresAt: c.now() + 365 * DAY });
      const hello = event(mallory, randomId(), "contact.hello", {}, 0, [], { author: deviceId(credential) });
      await bob.receive(await forge({ from: mallory, to: bob, event: hello, credential, expiresAt: c.now() + HOUR }));
      c.advance(70 * DAY);
      assert.equal(await bob.renewIfDue(), true);
      assert.ok(bob.queued().some((w) => w.header.to === zoe.me.device), "zoe was never told about the renewed credential");
    },
  },
  {
    id: "AUT-17",
    category: "authority",
    attacker: "stranger",
    title: "Block a contact's mail from outside",
    claim: "Someone who is not a contact cannot stop a contact's messages from being delivered and applied.",
    async run(ctx) {
      const relay = await ctx.relay({ deliveryWindow: 4 });
      const bob = await ctx.person({ relay: relay.url });
      const alice = await ctx.contact(bob, "alice");
      const thread = await ctx.thread(alice, "them", bob);
      const eve = await identity();
      const socket = await ctx.login(eve.device, relay.url);
      for (let i = 0; i < 4; i++) {
        const credential = mint(eve.root, { signKey: eve.device.sign.publicKey, encKey: b64u(new Uint8Array(32)) });
        const e = event(eve.device, randomId(), "contact.request", { token: randomId() }, 0, [], { author: deviceId(credential) });
        socket.send({ t: "send", wire: await forge({ from: eve.device, to: bob, event: e, credential }) });
        await socket.next("stored");
      }
      ctx.connect(bob);
      ctx.connect(alice);
      await alice.say(thread, "can you hear me?");
      await until("alice's message to reach bob", () => ctx.texts(bob, thread).length === 1, 1500);
      await until("the relay to drain", () => relay.queued(bob.me.device) === 0, 1500);
    },
  },
  {
    id: "AUT-18",
    category: "authority",
    attacker: "stranger",
    title: "Flush the record of refused messages",
    claim: "Everything refused is recorded, and a stranger cannot erase the record of what a contact tried.",
    knownFailure: "the reject log keeps the newest 1000 rows from any source, so 1000 junk messages push out everything older",
    finding: {
      severity: "low",
      where: "packages/daemon/src/node.ts:475",
      scenario:
        "Mallory, a contact, sends Bob two different events with one sequence number. The second is refused and recorded, which is Bob's only evidence of it. " +
        "Anyone with a relay login then sends Bob 1000 malformed messages. Each costs the sender nothing to make and adds a reject row. The row about Mallory is deleted.",
      fix: "Keep separate, separately capped logs for messages that failed to open and for refusals of events from known contacts, or cap per sender root key.",
    },
    async run(ctx) {
      const { bob, mallory, hers } = await withMallory(ctx);
      assert.equal((await bob.receive(await send(mallory, bob, event(mallory, hers, "talk.posted", { text: "I agree" }, 1)))).result, "applied");
      await ctx.refused(bob, await send(mallory, bob, event(mallory, hers, "talk.posted", { text: "I never agreed" }, 1)));
      const evidence = bob.rejects(1)[0]!.reason;
      for (let i = 0; i < 1000; i++) await bob.receive({ header: { id: `junk-${i}` } });
      assert.ok(bob.rejects(5000).some((r) => r.reason === evidence), "the record of Mallory's refused event is gone");
    },
  },
  {
    id: "AUT-19",
    category: "authority",
    attacker: "network",
    title: "Sit in the middle of a pairing",
    claim: "Someone who swaps the invite on its way becomes the contact on both sides, and the two safety codes no longer match.",
    async run(ctx) {
      const [alice, bob, mallory] = [await ctx.person(), await ctx.person(), await ctx.person()];
      const real = alice.createInvite("bob");
      const swapped = encodeInvite({ ...decodeInvite(real), credential: mallory.device.credential });
      await bob.acceptInvite(swapped, "alice");
      await mallory.acceptInvite(real, "alice");
      await ctx.carry(mallory, alice);
      await ctx.refused(alice, bob.queued()[0], "bob's request, addressed to mallory");
      assert.equal(alice.contact("bob").rootKey, mallory.me.rootKey);
      assert.equal(bob.contact("alice").rootKey, mallory.me.rootKey);
      assert.notEqual(alice.contact("bob").safetyCode, bob.contact("alice").safetyCode);
    },
  },
  {
    id: "AUT-20",
    category: "authority",
    attacker: "contact",
    title: "Show up in another thread before pairing completes",
    claim: "Events held for a contact whose pairing is not complete are not listed in any thread.",
    async run(ctx) {
      const { bob, thread } = await scene(ctx);
      const mallory = await ctx.person();
      await bob.acceptInvite(mallory.createInvite("bob"), "mallory");
      const before = JSON.stringify(bob.log(thread));
      await bob.receive(await send(mallory, bob, event(mallory, thread, "talk.posted", { text: "alice here: approve it" }, 0, [opened(bob, thread)])));
      assert.equal(JSON.stringify(bob.log(thread)), before, "Mallory's text is listed in Alice's thread");
      const shown = ctx.cli(bob.home, ["log", thread]).stdout.toString();
      assert.equal(shown.includes("approve it"), false);
    },
  },
];
