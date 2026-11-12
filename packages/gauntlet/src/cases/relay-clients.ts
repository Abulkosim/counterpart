import assert from "node:assert/strict";
import { type Wire, RELAY_AUTH_DOMAIN, deviceId, randomId, relayAuthMessage, sign } from "@counterpart/protocol";
import { type Client, type Ctx, type Identity, DAY, HOUR, clock, event, forge, identity, mint, pause, until } from "../harness.ts";
import type { Case } from "../types.ts";

const WEEK = 7 * DAY;
const dev = (i: Identity): string => deviceId(i.device.credential);
const mail = (from: Identity, to: Identity, expiresAt = Date.now() + HOUR): Promise<Wire> =>
  forge({ from: from.device, to: to.device.credential, event: event(from.device, randomId(), "talk.posted", { text: "x" }), expiresAt });

async function stored(c: Client, wire: Wire): Promise<void> {
  c.send({ t: "send", wire });
  const f = await c.next();
  assert.deepEqual(f, { t: "stored", id: wire.header.id });
}
async function refusedWith(c: Client, wire: unknown): Promise<string> {
  c.send({ t: "send", wire });
  const f = await c.next();
  assert.equal(f.t, "error");
  return f.code!;
}
async function stillReceives(ctx: Ctx, url: string, victim: Client, to: Identity): Promise<void> {
  const from = await identity();
  const wire = await mail(from, to);
  await stored(await ctx.login(from.device, url), wire);
  assert.equal((await victim.next("deliver")).wire!.header.id, wire.header.id);
  assert.ok(victim.isOpen());
}

export const relayClients: Case[] = [
  {
    id: "RC-01",
    category: "relay-clients",
    attacker: "stranger",
    title: "Use the relay without logging in",
    claim: "Before a valid login the relay accepts nothing but a login.",
    async run(ctx) {
      const relay = await ctx.relay();
      const [a, b] = [await identity(), await identity()];
      const wire = await mail(a, b);
      const firsts: unknown[] = [{ t: "send", wire }, { t: "ack", id: wire.header.id }, { t: "ready", device: dev(a) }, { t: "auth" }, { t: "auth", credential: a.device.credential }, "not json", Buffer.from([1, 2, 3]), [], { t: 1 }];
      for (const first of firsts) {
        const c = ctx.dial(relay.url);
        await c.next("challenge");
        c.send(first);
        assert.ok([4002, 4003].includes(await c.closed), JSON.stringify(first));
        assert.equal(c.seen("ready").length, 0);
      }
      assert.equal(relay.queued(), 0);
      assert.equal(await ctx.online(relay), 0);
    },
  },
  {
    id: "RC-02",
    category: "relay-clients",
    attacker: "network",
    title: "Replay a captured login",
    claim: "A login is bound to one connection's challenge and cannot be replayed on another.",
    async run(ctx) {
      const relay = await ctx.relay();
      const victim = await identity();
      const v = ctx.dial(relay.url);
      const { nonce } = await v.next("challenge");
      const auth = { t: "auth", credential: victim.device.credential, relay: relay.url, sig: sign(victim.device.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(nonce!, relay.url)) };
      v.send(auth);
      await v.next("ready");
      for (let i = 0; i < 3; i++) {
        const replay = ctx.dial(relay.url);
        await replay.next("challenge");
        replay.send(auth);
        assert.equal(await replay.closed, 4003);
      }
      await stillReceives(ctx, relay.url, v, victim);
    },
  },
  {
    id: "RC-03",
    category: "relay-clients",
    attacker: "stranger",
    title: "Knock a device offline",
    claim: "Only a login with the device's own key replaces its connection.",
    async run(ctx) {
      const relay = await ctx.relay();
      const [victim, eve] = [await identity(), await identity()];
      const v = await ctx.login(victim.device, relay.url);
      const attempt = async (credential: unknown, signer = eve.device.sign): Promise<Client> => {
        const c = ctx.dial(relay.url);
        const { nonce } = await c.next("challenge");
        c.send({ t: "auth", credential, relay: relay.url, sig: sign(signer, RELAY_AUTH_DOMAIN, relayAuthMessage(nonce!, relay.url)) });
        return c;
      };
      assert.equal(await (await attempt(victim.device.credential)).closed, 4003, "victim's credential, eve's key");
      assert.equal(await (await attempt(victim.device.credential, eve.root)).closed, 4003, "victim's credential, eve's root key");
      const adopted = mint(eve.root, { signKey: victim.device.credential.signKey, encKey: victim.device.credential.encKey });
      assert.equal(deviceId(adopted), dev(victim));
      assert.equal(await (await attempt(adopted)).closed, 4003, "same device id under eve's root");

      const e = await ctx.login(eve.device, relay.url);
      e.send({ t: "auth", credential: victim.device.credential, relay: relay.url, sig: "A".repeat(86) });
      assert.equal(await e.closed, 4002, "second login on an open session");
      await until("eve's sockets to close", async () => (await ctx.online(relay)) === 1);
      await stillReceives(ctx, relay.url, v, victim);

      await ctx.login(victim.device, relay.url);
      assert.equal(await v.closed, 4009, "the owner's own second login does replace the first");
    },
  },
  {
    id: "RC-04",
    category: "relay-clients",
    attacker: "stranger",
    title: "Read or delete someone else's mail",
    claim: "Mail is delivered only to the device it is addressed to, and only that device can acknowledge it away.",
    async run(ctx) {
      const relay = await ctx.relay();
      const [a, b, eve] = [await identity(), await identity(), await identity()];
      const sender = await ctx.login(a.device, relay.url);
      const wire = await mail(a, b);
      await stored(sender, wire);
      const e = await ctx.login(eve.device, relay.url);
      for (const c of [e, sender]) for (let i = 0; i < 3; i++) c.send({ t: "ack", id: wire.header.id });
      const probe = await mail(eve, eve);
      await stored(e, probe);
      assert.equal((await e.next("deliver")).wire!.header.id, probe.header.id);
      assert.equal(relay.queued(dev(b)), 1);
      assert.equal(e.seen("deliver").length, 1);
      assert.equal(sender.seen("deliver").length, 0);
      const recipient = await ctx.login(b.device, relay.url);
      assert.deepEqual((await recipient.next("deliver")).wire, wire);
    },
  },
  {
    id: "RC-05",
    category: "relay-clients",
    attacker: "contact",
    title: "Get around the per-sender quota",
    claim: "One device cannot queue more than its share, by reconnecting, by spraying recipients, or by resending.",
    async run(ctx) {
      const relay = await ctx.relay({ maxPerSender: 3, maxPerSenderTotal: 5 });
      const [a, b, c] = [await identity(), await identity(), await identity()];
      let s = await ctx.login(a.device, relay.url);
      const first = await mail(a, b);
      await stored(s, first);
      for (let i = 0; i < 2; i++) await stored(s, await mail(a, b));
      assert.equal(await refusedWith(s, await mail(a, b)), "mailbox_full");
      s = await ctx.login(a.device, relay.url);
      assert.equal(await refusedWith(s, await mail(a, b)), "mailbox_full", "after reconnecting");
      await stored(s, first);
      for (let i = 0; i < 2; i++) await stored(s, await mail(a, c));
      assert.equal(await refusedWith(s, await mail(a, c)), "mailbox_full", "total across recipients");
      assert.equal(await refusedWith(s, await mail(a, await identity())), "mailbox_full", "a fresh recipient");
      assert.equal(relay.queued(), 5);

      const r = await ctx.login(b.device, relay.url);
      r.send({ t: "ack", id: (await r.next("deliver")).wire!.header.id });
      await until("the acknowledgement to free a slot", () => relay.queued() === 4);
      await stored(s, await mail(a, b));
    },
  },
  {
    id: "RC-06",
    category: "relay-clients",
    attacker: "stranger",
    title: "Fill a mailbox with throwaway identities",
    claim: "Strangers cannot use up a mailbox so that mail from the owner's contacts is turned away.",
    async run(ctx) {
      const relay = await ctx.relay({ maxPerSender: 5, maxPerMailbox: 20, maxUnknownPerMailbox: 6, maxPerUnknownSender: 2 });
      const [alice, bob] = [await identity(), await identity()];
      // Bob has accepted mail from Alice before, which is what makes her known to the relay.
      const a = await ctx.login(alice.device, relay.url);
      const first = await mail(alice, bob);
      await stored(a, first);
      const b = await ctx.login(bob.device, relay.url);
      await b.next("deliver");
      b.send({ t: "ack", id: first.header.id, ok: true });
      await pause(50);
      b.ws.close();
      await pause(50);
      let strangersStored = 0;
      for (let i = 0; i < 8; i++) {
        const sybil = await identity();
        const s = await ctx.login(sybil.device, relay.url);
        for (let j = 0; j < 5; j++) {
          s.send({ t: "send", wire: await mail(sybil, bob) });
          if ((await s.next()).t === "stored") strangersStored++;
        }
      }
      assert.equal(strangersStored, 6, "strangers share a small allowance");
      for (let j = 0; j < 5; j++) await stored(a, await mail(alice, bob));
    },
  },
  {
    id: "RC-07",
    category: "relay-clients",
    attacker: "stranger",
    title: "Flood the relay with frames",
    claim: "A connection that sends faster than the rate limit is closed, and other clients are not affected.",
    async run(ctx) {
      const relay = await ctx.relay();
      const [eve, a, b] = [await identity(), await identity(), await identity()];
      const good = await ctx.login(b.device, relay.url);
      const e = await ctx.login(eve.device, relay.url);
      const wire = await mail(eve, a);
      for (let i = 0; i < 400; i++) e.send(i % 2 ? { t: "ack", id: randomId() } : { t: "send", wire });
      assert.equal(await e.closed, 4008);
      assert.ok(relay.queued() <= 1);
      await stillReceives(ctx, relay.url, good, b);
    },
  },
  {
    id: "RC-08",
    category: "relay-clients",
    attacker: "stranger",
    title: "Overwrite a queued message by reusing its id",
    claim: "A queued message cannot be replaced or duplicated by another account that knows its id.",
    async run(ctx) {
      const relay = await ctx.relay();
      const [a, b, eve] = [await identity(), await identity(), await identity()];
      const wire = await mail(a, b);
      await stored(await ctx.login(a.device, relay.url), wire);
      const e = await ctx.login(eve.device, relay.url);
      const fake = await forge({ from: eve.device, to: b.device.credential, event: event(eve.device, randomId(), "talk.posted", { text: "replacement" }, 0, [], { id: wire.header.id }) });
      assert.equal(fake.header.id, wire.header.id);
      assert.equal(await refusedWith(e, fake), "conflict");
      assert.equal(await refusedWith(e, wire), "conflict", "same bytes from another account");
      assert.equal(await refusedWith(e, { ...wire, ct: `${wire.ct}AAAA` }), "conflict");
      assert.equal(relay.queued(dev(b)), 1);
      const r = await ctx.login(b.device, relay.url);
      assert.deepEqual((await r.next("deliver")).wire, wire);
      await pause(50);
      assert.equal(r.seen("deliver").length, 1);
    },
  },
  {
    id: "RC-09",
    category: "relay-clients",
    attacker: "stranger",
    title: "Send oversized messages and frames",
    claim: "A message over 256 KB is refused and a frame over the socket limit closes the connection. Neither is stored.",
    async run(ctx) {
      const relay = await ctx.relay();
      const [eve, b] = [await identity(), await identity()];
      const good = await mail(eve, b);
      const e = await ctx.login(eve.device, relay.url);
      assert.equal(await refusedWith(e, { ...good, ct: "A".repeat(300_000) }), "too_large");
      assert.equal(await refusedWith(e, { ...good, ct: "A".repeat(256 * 1024) }), "too_large");
      e.send({ t: "send", wire: { ...good, ct: "A".repeat(700_000) } });
      assert.ok([1009, 1006].includes(await e.closed));
      const again = await ctx.login(eve.device, relay.url);
      again.send(JSON.stringify({ t: "ack", id: randomId(), pad: "x".repeat(3_000_000) }));
      assert.ok([1009, 1006].includes(await again.closed));
      assert.equal(relay.queued(), 0);
      await stored(await ctx.login(eve.device, relay.url), good);
    },
  },
  {
    id: "RC-10",
    category: "relay-clients",
    attacker: "stranger",
    title: "Park mail on the relay for longer than allowed",
    claim: "The relay stores a message for at most seven days, and not at all if it has already expired.",
    async run(ctx) {
      const c = clock();
      const relay = await ctx.relay({ now: c.now });
      const [eve, b] = [await identity(), await identity()];
      const e = await ctx.login(eve.device, relay.url);
      const t = c.now();
      for (const expiresAt of [t + WEEK + 1, t + 365 * DAY, Number.MAX_SAFE_INTEGER]) assert.equal(await refusedWith(e, await mail(eve, b, expiresAt)), "ttl_too_long");
      for (const expiresAt of [t, t - 1, 0]) assert.equal(await refusedWith(e, await mail(eve, b, expiresAt)), "expired");
      const good = await mail(eve, b, t + WEEK);
      for (const expiresAt of [-1, t + 0.5, String(t + HOUR), null]) assert.equal(await refusedWith(e, { ...good, header: { ...good.header, expiresAt } }), "bad_wire");
      assert.equal(relay.queued(), 0);
      await stored(e, good);

      c.advance(WEEK);
      const r = await ctx.login(b.device, relay.url);
      await stored(await ctx.login(eve.device, relay.url), await mail(eve, b, c.now() + HOUR));
      await r.next("deliver");
      assert.equal(r.seen("deliver").some((f) => f.wire!.header.id === good.header.id), false, "an expired message was delivered");
    },
  },
  {
    id: "RC-11",
    category: "relay-clients",
    attacker: "stranger",
    title: "Hold open connections that never log in",
    claim: "The relay limits how many connections can sit unauthenticated at once.",
    async run(ctx) {
      const relay = await ctx.relay();
      const n = 200;
      const sockets = Array.from({ length: n }, () => ctx.dial(relay.url));
      await Promise.all(sockets.map((s) => Promise.race([s.next("challenge", 4000).catch(() => {}), s.closed])));
      await pause(100);
      const open = sockets.filter((s) => s.isOpen()).length;
      assert.ok(open < n, `all ${n} unauthenticated connections were accepted and kept open`);
    },
  },
  {
    id: "RC-12",
    category: "relay-clients",
    attacker: "stranger",
    title: "Send malformed frames after logging in",
    claim: "A logged-in client cannot crash the relay or store anything with malformed frames.",
    async run(ctx) {
      const relay = await ctx.relay();
      const [eve, b] = [await identity(), await identity()];
      const good = await mail(eve, b);
      const deep = "[".repeat(20_000) + "]".repeat(20_000);
      const nested = (frame: unknown): string => JSON.stringify(frame).replace('"DEEP"', deep);
      const frames: unknown[] = [
        "not json", "{", "null", "[]", Buffer.from([0xff, 0xfe]), { t: 5 }, {}, { t: "nope" }, { t: "__proto__" }, { t: "deliver", wire: good }, { t: "stored", id: good.header.id },
        { t: "auth", credential: eve.device.credential, relay: relay.url, sig: "x" },
        { t: "send" }, { t: "send", wire: null }, nested({ t: "send", wire: "DEEP" }), nested({ t: "send", wire: { ...good, header: "DEEP" } }), nested({ t: "send", wire: { ...good, enc: "DEEP" } }), nested({ t: "DEEP" }),
        { t: "send", wire: { ...good, extra: 1 } }, { t: "send", wire: { ...good, header: { ...good.header, to: "d_short" } } }, { t: "send", wire: { ...good, header: { ...good.header, to: `x_${dev(b).slice(2)}` } } },
        { t: "send", wire: { ...good, header: { ...good.header, id: "../../x" } } }, { t: "send", wire: { ...good, enc: "" } }, { t: "send", wire: { ...good, ct: "" } }, { t: "send", wire: { ...good, ct: 5 } },
        { t: "ack" }, { t: "ack", id: {} }, { t: "ack", id: "'; DROP TABLE mailbox; --" }, nested({ t: "ack", id: "DEEP" }),
      ];
      for (const frame of frames) {
        const c = await ctx.login(eve.device, relay.url);
        c.send(frame);
        c.send({ t: "ack", id: randomId() });
        await Promise.race([c.closed, pause(15)]);
      }
      assert.equal(relay.queued(), 0);
      await stored(await ctx.login(eve.device, relay.url), good);
      assert.equal(relay.queued(dev(b)), 1);
    },
  },
  {
    id: "RC-13",
    category: "relay-clients",
    attacker: "stranger",
    title: "Log in with a credential that is not current",
    claim: "The relay refuses expired and future-dated credentials, and credentials not signed by their root key.",
    async run(ctx) {
      const c = clock();
      const relay = await ctx.relay({ now: c.now });
      const eve = await identity(c.now());
      const keys = { signKey: eve.device.sign.publicKey, encKey: eve.device.enc.publicKey };
      const t = c.now();
      const attempt = async (credential: unknown): Promise<number> => {
        const s = ctx.dial(relay.url);
        const { nonce } = await s.next("challenge");
        s.send({ t: "auth", credential, relay: relay.url, sig: sign(eve.device.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(nonce!, relay.url)) });
        return Promise.race([s.closed, s.next("ready", 1500).then(() => 0, () => -1)]);
      };
      assert.equal(await attempt(mint(eve.root, { ...keys, issuedAt: t - DAY, expiresAt: t })), 4003, "expires now");
      assert.equal(await attempt(mint(eve.root, { ...keys, issuedAt: t + 6 * 60_000, expiresAt: t + DAY })), 4003, "issued in the future");
      assert.equal(await attempt({ ...eve.device.credential, expiresAt: eve.device.credential.expiresAt + 1 }), 4003, "edited");
      assert.equal(await attempt(mint(eve.root, keys, eve.device.sign)), 4003, "signed by the device key");
      assert.equal(await attempt(mint(eve.root, { ...keys, issuedAt: t - DAY, expiresAt: t + 1 })), 0, "valid for one more millisecond");
      c.advance(1);
      assert.equal(await attempt(mint(eve.root, { ...keys, issuedAt: t - DAY, expiresAt: t + 1 })), 4003, "a millisecond later");
    },
  },
  {
    id: "RC-14",
    category: "relay-clients",
    attacker: "stranger",
    title: "Reset the rate limit by reconnecting",
    claim: "The frame rate limit applies to a device, not to one connection.",
    async run(ctx) {
      const c = clock();
      const relay = await ctx.relay({ now: c.now, framesPerSecond: 10 });
      const eve = await identity(c.now());
      // The clock is stopped, so the allowance of 20 frames never refills.
      let sent = 0;
      for (let round = 0; round < 3; round++) {
        const s = await ctx.login(eve.device, relay.url);
        for (let i = 0; i < 15; i++) s.send({ t: "ack", id: randomId() });
        sent += 15;
        const probe = await mail(eve, eve);
        s.send({ t: "send", wire: probe });
        const outcome = await Promise.race([s.closed, s.next("stored", 1500).then(() => 0, () => -1)]);
        if (outcome !== 0) return;
      }
      assert.fail(`one device sent ${sent} frames with an allowance of 20 and was never limited`);
    },
  },
];
