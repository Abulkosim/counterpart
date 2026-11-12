import assert from "node:assert/strict";
import type { Counterpart } from "@counterpart/daemon";
import { type Wire, randomId } from "@counterpart/protocol";
import { type Ctx, type EvilConn, type EvilRelay, event, identity, pause, send, until } from "../harness.ts";
import type { Case } from "../types.ts";

const greet = (c: EvilConn): void => c.send({ t: "ready", device: "d_whatever" });
const challenge = (c: EvilConn): void => c.send({ t: "challenge", nonce: randomId(24) });

// Bob's daemon dials a relay the attacker runs. Alice and the thread were set up beforehand.
async function wired(ctx: Ctx, onConn: (c: EvilConn) => void = greet, opts: Parameters<Ctx["evilRelay"]>[1] = {}): Promise<{ evil: EvilRelay; bob: Counterpart; alice: Counterpart; thread: string }> {
  const evil = await ctx.evilRelay(onConn, opts);
  const bob = await ctx.person({ relay: evil.url });
  const alice = await ctx.contact(bob, "alice");
  const thread = await ctx.thread(alice, "them", bob);
  return { evil, bob, alice, thread };
}
const talk = (alice: Counterpart, bob: Counterpart, thread: string, text: string, seq: number): Promise<Wire> => send(alice, bob, event(alice, thread, "talk.posted", { text }, seq));

// Answer every send with `stored`, as an honest relay would, and keep the wires.
function store(c: EvilConn): Wire[] {
  const wires: Wire[] = [];
  c.ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString()) as { t: string; wire: Wire };
    if (f.t !== "send" || wires.some((w) => w.header.id === f.wire.header.id)) return;
    wires.push(f.wire);
    c.send({ t: "stored", id: f.wire.header.id });
  });
  return wires;
}

// Alice writes a thread of six messages through the hostile relay, which keeps them.
async function captured(ctx: Ctx): Promise<{ evil: EvilRelay; bob: Counterpart; alice: Counterpart; thread: string; wires: Wire[]; toBob: () => Promise<EvilConn> }> {
  const evil = await ctx.evilRelay(challenge);
  const bob = await ctx.person({ relay: evil.url });
  const alice = await ctx.contact(bob, "alice");
  ctx.connect(alice);
  const a = await evil.conn(0);
  await a.wait("auth");
  const wires = store(a);
  a.send({ t: "ready", device: alice.me.device });
  const thread = await alice.openThread("them", "through a hostile relay");
  for (const t of ["1", "2", "3", "4", "5", "6"]) await alice.say(thread, t);
  await until("the relay to hold seven messages", () => wires.length === 7);
  return {
    evil, bob, alice, thread, wires,
    async toBob() {
      ctx.connect(bob);
      const b = await evil.conn(1);
      await b.wait("auth");
      b.send({ t: "ready", device: bob.me.device });
      return b;
    },
  };
}

export const hostileRelay: Case[] = [
  {
    id: "HR-01",
    category: "hostile-relay",
    attacker: "relay",
    title: "Send frames that are not frames",
    claim: "Garbage from the relay is ignored or refused, and the daemon keeps its connection and its state.",
    async run(ctx) {
      const { evil, bob, alice, thread } = await wired(ctx);
      const link = ctx.connect(bob);
      const conn = await evil.conn();
      await until("the link to come up", () => link.online);
      const before = ctx.snapshot(bob);
      const rejects = ctx.counts(bob).rejects;
      const junk: unknown[] = [
        "", "not json", "{", "null", "[]", "123", '"deliver"', '{"t":"deliver","wire":', Buffer.from([0, 1, 2, 255]),
        { t: 5 }, { t: null }, {}, { t: "__proto__" }, { t: "constructor" }, { t: "toString" }, { t: "valueOf", wire: {} },
        { t: "stored" }, { t: "stored", id: {} }, { t: "stored", id: ["a"] }, { t: "stored", id: 7 },
        { t: "error" }, { t: "error", id: 5, code: {} }, { t: "error", id: null, code: null },
        { t: "ready" }, { t: "ready", device: alice.me.device },
        { t: "challenge" }, { t: "challenge", nonce: 5 }, { t: "challenge", nonce: "short" }, { t: "challenge", nonce: "x".repeat(129) }, { t: "challenge", nonce: { toString: "x" } },
        { t: "auth", credential: alice.device.credential, relay: evil.url, sig: "x" }, { t: "send", wire: {} }, { t: "ack", id: randomId() },
      ];
      const deliveries: unknown[] = [{ t: "deliver" }, { t: "deliver", wire: null }, { t: "deliver", wire: "x" }, { t: "deliver", wire: [] }, { t: "deliver", wire: { header: { id: {} } } }, { t: "deliver", wire: { header: null, enc: 1, ct: 2 } }];
      for (const j of [...junk, ...deliveries]) conn.send(j);
      await until("the junk deliveries to be refused", () => ctx.counts(bob).rejects === rejects + deliveries.length);
      assert.equal(ctx.snapshot(bob), before);
      assert.equal(conn.count("auth"), 0, "the daemon signed a malformed challenge");

      conn.send({ t: "deliver", wire: await talk(alice, bob, thread, "still here", 1) });
      await until("a real message to be applied", () => ctx.texts(bob, thread).length === 1);
      assert.ok(conn.isOpen());
      assert.equal(evil.conns.length, 1);
    },
  },
  {
    id: "HR-02",
    category: "hostile-relay",
    attacker: "relay",
    title: "Send one enormous frame",
    claim: "A frame over the size limit is dropped unread and the daemon reconnects with its state intact.",
    async run(ctx) {
      const { evil, bob, alice, thread } = await wired(ctx);
      ctx.connect(bob);
      const first = await evil.conn(0);
      const before = ctx.snapshot(bob);
      const rejects = ctx.counts(bob).rejects;
      first.send(JSON.stringify({ t: "deliver", wire: { header: { id: randomId() }, enc: "x", ct: "A".repeat(4 * 1024 * 1024) } }));
      const second = await evil.conn(1);
      assert.equal(ctx.snapshot(bob), before);
      assert.equal(ctx.counts(bob).rejects, rejects, "the oversized frame was parsed");
      second.send({ t: "deliver", wire: await talk(alice, bob, thread, "after the flood", 1) });
      await until("a real message to be applied", () => ctx.texts(bob, thread).length === 1);
    },
  },
  {
    id: "HR-03",
    category: "hostile-relay",
    attacker: "relay",
    title: "Send a compression bomb",
    claim: "A small compressed frame that inflates past the size limit is cut off, not buffered.",
    async run(ctx) {
      const { evil, bob, alice, thread } = await wired(ctx, greet, { perMessageDeflate: true });
      ctx.connect(bob);
      const first = await evil.conn(0);
      assert.match(first.ws.extensions, /permessage-deflate/, "test bug: compression was not negotiated");
      const before = ctx.snapshot(bob);
      const rejects = ctx.counts(bob).rejects;
      first.send(Buffer.alloc(32 * 1024 * 1024, 0x20));
      const second = await evil.conn(1);
      assert.equal(ctx.snapshot(bob), before);
      assert.equal(ctx.counts(bob).rejects, rejects);
      second.send({ t: "deliver", wire: await talk(alice, bob, thread, "after the bomb", 1) });
      await until("a real message to be applied", () => ctx.texts(bob, thread).length === 1);
    },
  },
  {
    id: "HR-04",
    category: "hostile-relay",
    attacker: "relay",
    title: "Flood the daemon with deliveries",
    claim: "A burst of deliveries is bounded in memory and on disk, changes nothing, and does not stop real mail.",
    async run(ctx) {
      const { evil, bob, alice, thread } = await wired(ctx);
      const link = ctx.connect(bob);
      const conn = await evil.conn();
      await until("the link to come up", () => link.online);
      const before = ctx.snapshot(bob);
      const other = await identity();
      const misaddressed = await send(alice, other.device.credential, event(alice, thread, "talk.posted", { text: "x" }, 9));
      for (let i = 0; i < 1000; i++) conn.send({ t: "deliver", wire: i % 2 ? { header: { id: randomId() }, enc: "", ct: "" } : { ...misaddressed, header: { ...misaddressed.header, id: randomId() } } });
      await until("the daemon to start refusing", () => ctx.counts(bob).rejects > 0);
      const real = await talk(alice, bob, thread, "real mail", 1);
      // Deliveries past the daemon's backlog are dropped unacknowledged, so an honest relay would send again.
      await until("a real message to be applied", () => {
        conn.send({ t: "deliver", wire: real });
        return ctx.texts(bob, thread).length === 1;
      }, 8000);
      await until("the daemon to acknowledge it", () => conn.frames.some((f) => f.t === "ack" && f.id === real.header.id));
      assert.ok(ctx.counts(bob).rejects <= 1000);
      assert.equal(bob.since(0, 10_000).length, JSON.parse(before).applied.length + 1);
      assert.equal(ctx.counts(bob).held, 0);
      assert.ok(conn.isOpen());
    },
  },
  {
    id: "HR-05",
    category: "hostile-relay",
    attacker: "relay",
    title: "Forge stored and error frames",
    claim: "Receipts from the relay only ever touch the outbox entry they name. They cannot alter received events, and a full mailbox is retried.",
    async run(ctx) {
      const { evil, bob, thread } = await wired(ctx);
      const mine = await bob.say(thread, "bob's message");
      ctx.connect(bob);
      const conn = await evil.conn();
      await conn.wait("send");
      const inbound = bob.since(0, 1000).filter((e) => !e.mine).map((e) => e.id);
      const before = ctx.snapshot(bob);
      for (const id of [...inbound, ...Array.from({ length: 20 }, () => randomId())]) {
        conn.send({ t: "stored", id });
        conn.send({ t: "error", id, code: "conflict" });
      }
      conn.send({ t: "error", code: "conflict" });
      conn.send({ t: "error", id: mine.id, code: "mailbox_full" });
      await conn.wait("send");
      assert.equal(bob.outboxState(mine.id), "queued");
      assert.equal(ctx.snapshot(bob), before);

      conn.send({ t: "stored", id: mine.id });
      await until("the outbox to settle", () => bob.outboxState(mine.id) === "stored");
      conn.send({ t: "error", id: mine.id, code: "conflict" });
      conn.send({ t: "error", id: mine.id, code: "expired" });
      await pause(60);
      assert.equal(bob.outboxState(mine.id), "stored");
      assert.equal(bob.log(thread).find((e) => e.id === mine.id)!.status, "applied");
    },
  },
  {
    id: "HR-06",
    category: "hostile-relay",
    attacker: "relay",
    title: "Accept the login and never say ready",
    claim: "Nothing leaves the outbox until the relay has confirmed the login, and the daemon does not spin.",
    async run(ctx) {
      const { evil, bob, thread } = await wired(ctx, challenge);
      const mine = await bob.say(thread, "waiting");
      const link = ctx.connect(bob);
      const conn = await evil.conn();
      await conn.wait("auth");
      await pause(250);
      assert.equal(conn.count("send"), 0);
      assert.equal(conn.count("auth"), 0, "the daemon logged in more than once");
      assert.equal(link.online, false);
      assert.equal(bob.outboxState(mine.id), "queued");
      assert.equal(evil.conns.length, 1);
    },
  },
  {
    id: "HR-07",
    category: "hostile-relay",
    attacker: "relay",
    title: "Forward another relay's challenge",
    claim: "A login made at one relay cannot be used at another, even when the first relay forwards the second one's challenge.",
    async run(ctx) {
      const real = await ctx.relay();
      const evil = await ctx.evilRelay();
      const bob = await ctx.person({ relay: evil.url });
      ctx.connect(bob);
      const victim = await evil.conn();
      for (const rewrite of [false, true]) {
        const up = ctx.dial(real.url);
        const { nonce } = await up.next("challenge");
        victim.send({ t: "challenge", nonce });
        const auth = await victim.wait("auth");
        up.send(rewrite ? { ...auth, relay: real.url } : auth);
        assert.equal(await up.closed, 4003);
        assert.equal(up.seen("ready").length, 0);
      }
      assert.equal(await ctx.online(real), 0);
    },
  },
  {
    id: "HR-08",
    category: "hostile-relay",
    attacker: "relay",
    title: "Deliver mail meant for someone else, and reflect mail back",
    claim: "The daemon only opens messages sealed to its own device, and never accepts its own messages back.",
    async run(ctx) {
      const { evil, bob, alice, thread } = await wired(ctx);
      const mine = await bob.say(thread, "bob's message");
      ctx.connect(bob);
      const conn = await evil.conn();
      const reflected = (await conn.wait("send")).wire as Wire;
      assert.equal(reflected.header.id, mine.id);
      const before = ctx.snapshot(bob);
      const rejects = ctx.counts(bob).rejects;
      const carol = await ctx.contact(alice, "carol");
      const theirs = await send(alice, carol, event(alice, thread, "talk.posted", { text: "for carol" }, 1));
      const relabelled = { ...theirs, header: { ...theirs.header, to: bob.me.device } };
      for (const wire of [reflected, theirs, relabelled, { ...reflected, header: { ...reflected.header, to: bob.me.device } }]) conn.send({ t: "deliver", wire });
      await until("all four to be refused", () => ctx.counts(bob).rejects === rejects + 4);
      assert.equal(ctx.snapshot(bob), before);
    },
  },
  {
    id: "HR-09",
    category: "hostile-relay",
    attacker: "relay",
    title: "Duplicate and reorder a conversation",
    claim: "Whatever order and however many times the relay delivers, each event is applied once, after its parents.",
    async run(ctx) {
      const { bob, thread, wires, toBob } = await captured(ctx);
      const b = await toBob();
      const backwards = [...wires].reverse();
      for (const wire of [...backwards, ...backwards, ...wires.slice(3), ...wires.slice(0, 3), ...backwards]) b.send({ t: "deliver", wire });
      await until("bob to have all six", () => ctx.texts(bob, thread).length === 6);
      await until("every delivery to be handled", () => b.count("ack") === wires.length * 4);
      assert.deepEqual(ctx.texts(bob, thread), ["1", "2", "3", "4", "5", "6"]);
      assert.equal(bob.log(thread).length, 7);
      assert.equal(ctx.counts(bob).held, 0);
    },
  },
  {
    id: "HR-10",
    category: "hostile-relay",
    attacker: "relay",
    title: "Drop one message from the middle",
    claim: "When the relay drops a message, later ones that depend on it are held and never shown as if nothing were missing.",
    async run(ctx) {
      const { bob, thread, wires, toBob } = await captured(ctx);
      const b = await toBob();
      for (const [i, wire] of wires.entries()) if (i !== 3) b.send({ t: "deliver", wire });
      await until("every delivery to be handled", () => b.count("ack") === wires.length - 1);
      assert.deepEqual(ctx.texts(bob, thread), ["1", "2"]);
      assert.equal(ctx.counts(bob).held, 3);
      const reply = await bob.say(thread, "did you say something?");
      const held = new Set(bob.log(thread).filter((e) => e.status === "pending").map((e) => e.id));
      assert.ok(reply.parents.every((p) => !held.has(p)), "bob's reply builds on an event he has not applied");
      b.send({ t: "deliver", wire: wires[3] });
      await until("the gap to close", () => ctx.texts(bob, thread).length === 7);
      assert.deepEqual(ctx.texts(bob, thread), ["1", "2", "did you say something?", "3", "4", "5", "6"]);
    },
  },
];
