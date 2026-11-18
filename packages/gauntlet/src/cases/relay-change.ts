import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Counterpart } from "@counterpart/daemon";
import { type EventBodies, encodeInvite, generateSigningKey, randomId } from "@counterpart/protocol";
import { type Ctx, DAY, event, forge, pause, scene, send } from "../harness.ts";
import type { Case } from "../types.ts";

type List = EventBodies["contact.relays"];
const list = (relays: string[], version: number, seen = 0): List => ({ relays, version, seen });
const relaysEvent = (from: Counterpart, body: List, seq = 0, parents: string[] = []) => event(from, randomId(), "contact.relays", body, seq, parents);

// What Bob believes about every contact's relays and where his mail to each goes.
function routing(bob: Counterpart): string {
  return JSON.stringify(
    bob.contacts().map((c) => {
      const t = bob.relayBook.their(c.rootKey, c.relay);
      return { name: c.name, ...t, route: bob.relayBook.route(t.relays) };
    }),
  );
}

// Refused, recorded, and Bob's view of where everyone is did not move.
async function refusedList(ctx: Ctx, bob: Counterpart, wire: unknown, what: string): Promise<void> {
  const before = routing(bob);
  await ctx.refused(bob, wire, what);
  assert.equal(routing(bob), before, `${what}: refused, but relay routing changed`);
}

// Bob uses two relays. Alice and Mallory are contacts; Alice is on the first only.
async function twoContacts(ctx: Ctx): Promise<{ bob: Counterpart; alice: Counterpart; mallory: Counterpart; r1: string; r2: string }> {
  const { bob, alice } = await scene(ctx);
  const mallory = await ctx.contact(bob, "mallory");
  const r1 = bob.relay;
  const r2 = "ws://127.0.0.1:19/second";
  bob.relayBook.add(r2, null, Date.now());
  return { bob, alice, mallory, r1, r2 };
}

export const relayChange: Case[] = [
  {
    id: "RLY-01",
    category: "relay-change",
    attacker: "stranger",
    title: "Announce relays without being a contact",
    claim: "A relay list from a root key that is not a contact is refused and changes nothing.",
    async run(ctx) {
      const { bob } = await scene(ctx);
      const eve = await ctx.person();
      await refusedList(ctx, bob, await send(eve, bob, relaysEvent(eve, list(["ws://evil.example"], Date.now()))), "stranger's list");
    },
  },
  {
    id: "RLY-02",
    category: "relay-change",
    attacker: "contact",
    title: "Move another contact's relays",
    claim: "A contact's relay list changes only that contact's entry: it cannot move where mail for anyone else goes.",
    async run(ctx) {
      const { bob, alice, mallory, r1, r2 } = await twoContacts(ctx);
      const aliceBefore = JSON.stringify(bob.relayBook.their(alice.me.rootKey, bob.contact("alice").relay));
      const routeBefore = JSON.stringify(bob.relayBook.route([r1]));
      // Mallory names Bob's second relay, Alice's relay and a relay of her own.
      const v = await bob.receive(await send(mallory, bob, relaysEvent(mallory, list(["ws://mallory.example", r2, r1], Date.now()))));
      assert.equal(v.result, "applied");
      assert.equal(JSON.stringify(bob.relayBook.their(alice.me.rootKey, bob.contact("alice").relay)), aliceBefore);
      assert.equal(JSON.stringify(bob.relayBook.route(bob.relayBook.their(alice.me.rootKey, r1).relays)), routeBefore);
      assert.deepEqual(bob.relayBook.route([r1]).preferred, [r1]);
      assert.deepEqual(bob.relayBook.their(mallory.me.rootKey, r1).relays, ["ws://mallory.example", r2, r1]);
      // Mallory's mail now prefers r2, a relay Bob already uses. Nothing else.
      assert.deepEqual(bob.relayBook.route(bob.relayBook.their(mallory.me.rootKey, r1).relays).preferred, [r2, r1]);
    },
  },
  {
    id: "RLY-03",
    category: "relay-change",
    attacker: "relay",
    title: "Forge a relay list in a contact's name",
    claim: "A relay list not signed by the contact's own device key is refused.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      const body = list(["ws://relay-in-the-middle.example"], Date.now());
      // Alice's credential and event, signed by a key the relay made up.
      await refusedList(ctx, bob, await forge({ from: alice, to: bob, event: relaysEvent(alice, body), signer: generateSigningKey() }), "signed by another key");
      // Alice's real signature, with the list swapped after signing.
      const real = relaysEvent(alice, body);
      const swapped = { ...real, body: list(["ws://swapped.example"], body.version) };
      await refusedList(ctx, bob, await forge({ from: alice, to: bob, event: real, inner: (i) => ({ ...i, event: swapped }) }), "list changed after signing");
      // Mallory, a contact, signs a list and puts Alice's credential on it.
      const mallory = await ctx.contact(bob, "mallory");
      await refusedList(ctx, bob, await forge({ from: mallory, to: bob, event: relaysEvent(mallory, body, 0, []), credential: alice.device.credential }), "mallory's signature, alice's credential");
      assert.deepEqual(bob.relayBook.their(alice.me.rootKey, bob.relay).relays, [bob.relay]);
    },
  },
  {
    id: "RLY-04",
    category: "relay-change",
    attacker: "relay",
    title: "Replay a contact's relay list",
    claim: "The same relay list delivered again is a duplicate and changes nothing.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      const wire = await send(alice, bob, relaysEvent(alice, list(["ws://new.example", bob.relay], Date.now())));
      assert.equal((await bob.receive(wire)).result, "applied");
      const before = routing(bob);
      for (let i = 0; i < 3; i++) assert.equal((await bob.receive(wire)).result, "duplicate");
      assert.equal(routing(bob), before);
    },
  },
  {
    id: "RLY-05",
    category: "relay-change",
    attacker: "relay",
    title: "Deliver an older relay list after a newer one",
    claim: "A relay list older than the one held is refused, so a relay cannot roll a contact back to a relay they left.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      const t = Date.now();
      const old = await send(alice, bob, relaysEvent(alice, list(["ws://old.example", bob.relay], t - 60_000)));
      const fresh = await send(alice, bob, relaysEvent(alice, list(["ws://new.example", bob.relay], t)));
      assert.equal((await bob.receive(fresh)).result, "applied");
      await refusedList(ctx, bob, old, "older list after newer");
      assert.equal(bob.relayBook.their(alice.me.rootKey, bob.relay).relays[0], "ws://new.example");
      // The same version with a different list is no newer either.
      await refusedList(ctx, bob, await send(alice, bob, relaysEvent(alice, list(["ws://other.example"], t))), "same version, different list");
    },
  },
  {
    id: "RLY-06",
    category: "relay-change",
    attacker: "contact",
    title: "Date a relay list in the future, or confirm a list that was never sent",
    claim: "A relay list dated ahead of the clock, or confirming a version of Bob's list that does not exist, is refused.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      await refusedList(ctx, bob, await send(alice, bob, relaysEvent(alice, list([bob.relay], Date.now() + DAY))), "future version");
      assert.equal(bob.relayBook.version(), 0);
      await refusedList(ctx, bob, await send(alice, bob, relaysEvent(alice, list([bob.relay], Date.now(), 5))), "confirms a version that does not exist");
      bob.relayBook.add("ws://127.0.0.1:19/b", null, Date.now());
      await refusedList(ctx, bob, await send(alice, bob, relaysEvent(alice, list([bob.relay], Date.now(), bob.relayBook.version() + 1))), "confirms a later version");
    },
  },
  {
    id: "RLY-07",
    category: "relay-change",
    attacker: "contact",
    title: "Send relay lists that are not lists of relay addresses",
    claim: "A relay list with no entries, too many, duplicates, or anything but plain ws and wss addresses is refused.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      const t = Date.now();
      const bad: List[] = [
        list([], t),
        list(Array.from({ length: 17 }, (_, i) => `ws://r${i}.example`), t),
        list(["ws://a.example", "ws://A.example:80/"], t),
        list(["http://a.example"], t),
        list(["wss://user:pass@a.example"], t),
        list(["wss://a.example/?q=1"], t),
        list(["wss://a.example/#x"], t),
        list(["wss://a.example/‮"], t),
        list(["file:///etc/passwd"], t),
        list(["wss://" + "a".repeat(600)], t),
        list(["ws://a.example"], -1),
        list(["ws://a.example"], 1, -1),
      ];
      // Sealed and signed by Alice herself: the honest library would not build these.
      for (const b of bad) await refusedList(ctx, bob, await forge({ from: alice, to: bob, event: relaysEvent(alice, b) }), JSON.stringify(b).slice(0, 60));
      await refusedList(ctx, bob, await forge({ from: alice, to: bob, event: event(alice, randomId(), "contact.relays", { relays: ["ws://a.example"], version: t, seen: 0, extra: 1 } as never) }), "unknown field");
    },
  },
  {
    id: "RLY-08",
    category: "relay-change",
    attacker: "contact",
    title: "Send a relay list inside a thread",
    claim: "A relay list stands alone: one with a sequence number, parents or a thread's id is refused.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const opened = bob.log(thread)[0]!.id;
      await refusedList(ctx, bob, await send(alice, bob, relaysEvent(alice, list(["ws://a.example"], Date.now()), 1)), "sequence number");
      await refusedList(ctx, bob, await send(alice, bob, relaysEvent(alice, list(["ws://a.example"], Date.now()), 0, [opened])), "parents");
      await refusedList(ctx, bob, await send(alice, bob, event(alice, thread, "contact.relays", list(["ws://a.example"], Date.now()))), "thread id");
    },
  },
  {
    id: "RLY-10",
    category: "relay-change",
    attacker: "contact",
    title: "Send the same stale relay list over and over",
    claim: "Repeating a relay list makes Bob store nothing more and answer at most once a minute.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      bob.relayBook.add("ws://127.0.0.1:19/b", null, Date.now());
      const body = list([bob.relay], Date.now(), 0); // never confirms Bob's list
      assert.equal((await bob.receive(await send(alice, bob, relaysEvent(alice, body)))).result, "applied");
      assert.equal(await bob.sendRelayLists(), 1, "the first one is answered");
      const events = ctx.counts(bob).events;
      for (let i = 0; i < 20; i++) assert.equal((await bob.receive(await send(alice, bob, relaysEvent(alice, body)))).result, "applied");
      assert.equal(ctx.counts(bob).events, events, "repeats were stored");
      await pause(5100); // past the spacing between two lists to one contact
      assert.equal(await bob.sendRelayLists(), 0, "a repeat earned another answer within the minute");
    },
  },
  {
    id: "RLY-09",
    category: "relay-change",
    attacker: "contact",
    title: "Point Bob's daemon at an address of the contact's choosing",
    claim: "Relays a contact names are never dialled: the daemon connects only to relays its owner added.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      // Something on Bob's own machine the contact would like him to touch.
      let touched = 0;
      const trap = createServer((s) => {
        touched++;
        s.destroy();
      });
      await new Promise<void>((r) => trap.listen(0, "127.0.0.1", () => r()));
      const trapUrl = `ws://127.0.0.1:${(trap.address() as { port: number }).port}`;
      try {
        const relay = await ctx.relay();
        // Bob's daemon runs against a real relay he chose.
        bob.relayBook.add(relay.url, null, Date.now());
        const link = ctx.connect(bob);
        assert.equal((await bob.receive(await send(alice, bob, relaysEvent(alice, list([trapUrl], Date.now()))))).result, "applied");
        await alice.say(await alice.openThread("them", "where are you"), "write to me");
        await ctx.carry(alice, bob);
        await bob.say(bob.threads()[0]!.id, "answer");
        await pause(1500);
        assert.equal(touched, 0, "the daemon dialled an address a contact named");
        assert.ok(link.connected().every((u) => bob.relayBook.mine().some((r) => r.url === u)));
        // Bob's answer went to a relay Bob uses, not to the contact's address.
        assert.ok(bob.relayBook.route([trapUrl]).preferred.length === 0);
      } finally {
        trap.close();
      }
    },
  },
  {
    id: "RLY-11",
    category: "relay-change",
    attacker: "stranger",
    title: "Reach a service on Bob's machine through the container name",
    claim: "An invite naming host.docker.internal is treated as an address on Bob's own machine: join asks first and touches nothing until he says yes.",
    async run(ctx) {
      // Something on Bob's machine the inviter would like his CLI to talk to.
      let touched = 0;
      const trap = createServer((s) => {
        touched++;
        s.destroy();
      });
      await new Promise<void>((r) => trap.listen(0, "127.0.0.1", () => r()));
      try {
        const eve = await ctx.person();
        const relay = `ws://host.docker.internal:${(trap.address() as { port: number }).port}`;
        const invite = encodeInvite({ v: 1, relay, credential: eve.device.credential, token: randomId(), expiresAt: Date.now() + DAY });
        const home = ctx.dir();
        // No terminal and no --yes: nobody can say yes.
        const r = ctx.cli(home, ["join", invite, "eve", "--no-passphrase", "--no-agents", "--no-boot"]);
        assert.notEqual(r.status, 0, `join went ahead: ${r.stdout.toString()}`);
        assert.match(r.stderr.toString(), /terminal/);
        assert.equal(existsSync(join(home, "keys.json")), false, "an identity was made");
        assert.equal(touched, 0, "the CLI connected to a local address the invite chose");
      } finally {
        trap.close();
      }
    },
  },
];
