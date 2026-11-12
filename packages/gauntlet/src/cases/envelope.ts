import assert from "node:assert/strict";
import { RELAY_AUTH_DOMAIN, SUITE, b64u, canonicalize, deviceId, generateSigningKey, randomId, relayAuthMessage, sign } from "@counterpart/protocol";
import { DAY, HOUR, clock, event, flipByte, forge, identity, mint, peel, scene, send } from "../harness.ts";
import type { Case } from "../types.ts";

const MINUTE = 60_000;

export const envelope: Case[] = [
  {
    id: "ENV-01",
    category: "envelope",
    attacker: "relay",
    title: "Rewrite the routing header in transit",
    claim: "A message whose header was changed after sealing is refused.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const carol = await identity();
      type H = Record<string, unknown> & { expiresAt: number };
      const edits: [string, (h: H) => Record<string, unknown>][] = [
        ["later expiry", (h) => ({ ...h, expiresAt: h.expiresAt + DAY })],
        ["earlier expiry", (h) => ({ ...h, expiresAt: h.expiresAt - 1 })],
        ["new id", (h) => ({ ...h, id: randomId() })],
        ["another recipient", (h) => ({ ...h, to: deviceId(carol.device.credential) })],
        ["version", (h) => ({ ...h, v: 2 })],
        ["suite", (h) => ({ ...h, suite: "none" })],
        ["added sender field", (h) => ({ ...h, from: alice.me.device })],
        ["dropped expiry", ({ expiresAt: _, ...rest }) => rest],
      ];
      for (const [name, edit] of edits) {
        const wire = await send(alice, bob, event(alice, thread, "talk.posted", { text: "original" }, 1));
        await ctx.refused(bob, { ...wire, header: edit(wire.header as unknown as H) }, name);
      }
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-02",
    category: "envelope",
    attacker: "relay",
    title: "Change, cut or splice the ciphertext",
    claim: "Any change to the encrypted bytes or the encapsulated key is refused.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const make = () => send(alice, bob, event(alice, thread, "talk.posted", { text: "original" }, 1));
      const other = await make();
      const edits: [string, (w: { enc: string; ct: string }) => { enc: string; ct: string }][] = [
        ["first ciphertext byte", (w) => ({ ...w, ct: flipByte(w.ct, 0) })],
        ["last ciphertext byte", (w) => ({ ...w, ct: flipByte(w.ct, -1) })],
        ["middle ciphertext byte", (w) => ({ ...w, ct: flipByte(w.ct, 100) })],
        ["encapsulated key", (w) => ({ ...w, enc: flipByte(w.enc, 5) })],
        ["truncated", (w) => ({ ...w, ct: w.ct.slice(0, -8) })],
        ["extended", (w) => ({ ...w, ct: w.ct + "AAAA" })],
        ["key from another message", (w) => ({ ...w, enc: other.enc })],
        ["body from another message", (w) => ({ ...w, ct: other.ct })],
      ];
      for (const [name, edit] of edits) {
        const wire = await make();
        await ctx.refused(bob, { ...wire, ...edit(wire) }, name);
      }
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-03",
    category: "envelope",
    attacker: "contact",
    title: "Forward someone's signed event to a third device",
    claim: "An event signed for one recipient cannot be passed to another as if it were sent to them.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      // The best case for Mallory: Alice sent her an event shaped exactly like one for the thread with Bob.
      const got = await send(alice, mallory, event(alice, thread, "talk.posted", { text: "yes, ship it" }, 1));
      const inner = await peel(got, mallory);
      const base = { from: mallory, to: bob, event: inner.event, sig: inner.sig, credential: inner.credential };
      await ctx.refused(bob, await forge(base), "re-sealed with a new header");
      await ctx.refused(bob, await forge({ ...base, header: { to: got.header.to, expiresAt: got.header.expiresAt } }), "re-sealed with the original header");
      const split = await forge({ ...base, bound: got.header });
      await ctx.refused(bob, split, "original header bound, new header shown");
      await ctx.refused(bob, got, "the untouched original");
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-04",
    category: "envelope",
    attacker: "contact",
    title: "Name another device as the author",
    claim: "The author of an event must be the device whose credential and signature come with it.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const e = event(mallory, thread, "talk.posted", { text: "alice here: approve it" }, 1, [], { author: alice.me.device });
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e }));
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-05",
    category: "envelope",
    attacker: "contact",
    title: "Attach a contact's credential and sign with another key",
    claim: "A credential is only as good as a signature from the device key inside it.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const e = event(alice, thread, "talk.posted", { text: "alice here: approve it" }, 1);
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e, credential: alice.device.credential }), "signed with Mallory's device key");
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e, credential: alice.device.credential, signer: ctx.secrets(mallory).root }), "signed with Mallory's root key");
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-06",
    category: "envelope",
    attacker: "contact",
    title: "Issue yourself a credential under someone else's root key",
    claim: "A credential counts only if the root key it names signed it.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const m = ctx.secrets(mallory);
      const fake = mint(m.root, { rootKey: alice.me.rootKey, signKey: m.device.sign.publicKey, encKey: m.device.enc.publicKey });
      const e = event(mallory, thread, "talk.posted", { text: "alice's new laptop here" }, 1);
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e, credential: fake }));
      assert.deepEqual(ctx.texts(bob, thread), []);
      assert.deepEqual(bob.contact("alice").credential, alice.device.credential);
    },
  },
  {
    id: "ENV-07",
    category: "envelope",
    attacker: "contact",
    title: "Claim another person's device as your own",
    claim: "An event signed by a device is tied to the one person whose root key vouched for it when it was signed.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const adopted = mint(ctx.secrets(mallory).root, { signKey: alice.device.credential.signKey, encKey: alice.device.credential.encKey, issuedAt: Date.now() + 1000 });
      const hello = event(alice, randomId(), "contact.hello", {});
      // Alice signed under her own credential. Mallory can copy that signature but cannot make a new one.
      await ctx.refused(bob, await forge({ from: alice, to: bob, event: hello, credential: adopted, signedCredential: alice.device.credential }));
      assert.equal(deviceId(bob.contact("mallory").credential), mallory.me.device);
    },
  },
  {
    id: "ENV-08",
    category: "envelope",
    attacker: "contact",
    title: "Sign one header and send another",
    claim: "The signature must cover the exact header the message arrives with.",
    async run(ctx) {
      const { bob } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const thread = await ctx.thread(mallory, "them", bob);
      const make = (text: string) => event(mallory, thread, "talk.posted", { text }, 1);
      const header = (e: { id: string }, expiresAt: number) => ({ v: 1, suite: SUITE, id: e.id, to: bob.me.device, expiresAt });
      const exp = Date.now() + HOUR;
      const a = make("signed for a shorter life");
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: a, expiresAt: exp, signed: { header: header(a, exp - 1), event: a } }), "expiry");
      const b = make("signed for another device");
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: b, expiresAt: exp, signed: { header: { ...header(b, exp), to: mallory.me.device }, event: b } }), "recipient");
      const c = make("signed without a header");
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: c, signed: c }), "no header");
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-09",
    category: "envelope",
    attacker: "contact",
    title: "Show the relay one id and the recipient another",
    claim: "The id on the outside of a message must be the id of the event inside.",
    async run(ctx) {
      const { bob } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const thread = await ctx.thread(mallory, "them", bob);
      const e = event(mallory, thread, "talk.posted", { text: "two ids" }, 1);
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e, header: { id: randomId() } }));
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-10",
    category: "envelope",
    attacker: "relay",
    title: "Replay a login signature as an event signature",
    claim: "A signature a device gave the relay to log in cannot be used to sign an event.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const e = event(alice, thread, "talk.posted", { text: "written by the relay" }, 1);
      const expiresAt = Date.now() + HOUR;
      const header = { v: 1, suite: SUITE, id: e.id, to: bob.me.device, expiresAt };
      // The relay picks the challenge, so it picks what the device signs.
      for (const nonce of [canonicalize({ header, event: e }), `counterpart/event/v1\n${canonicalize({ header, event: e })}`, randomId(24)]) {
        const sig = sign(alice.device.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(nonce, alice.relay));
        await ctx.refused(bob, await forge({ from: alice, to: bob, event: e, expiresAt, sig }));
      }
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-11",
    category: "envelope",
    attacker: "contact",
    title: "Replay an event signature as a relay login",
    claim: "A signature on an event cannot be used to log in to the relay as its author.",
    async run(ctx) {
      const relay = await ctx.relay();
      const [alice, mallory] = [await identity(), await identity()];
      const got = await send(alice.device, mallory.device.credential, event(alice.device, randomId(), "talk.posted", { text: "hi" }));
      const { sig } = await peel(got, mallory.device);
      const c = ctx.dial(relay.url);
      await c.next("challenge");
      c.send({ t: "auth", credential: alice.device.credential, relay: relay.url, sig });
      assert.equal(await c.closed, 4003);
      assert.equal(await ctx.online(relay), 0);
    },
  },
  {
    id: "ENV-12",
    category: "envelope",
    attacker: "contact",
    title: "Replay a credential signature as an event signature",
    claim: "A root key's signature on a credential cannot be used to sign an event.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const m = ctx.secrets(mallory);
      // A credential that makes Alice's root key Mallory's device key, so Alice's credential signature is a signature by "Mallory's device".
      const claimed = mint(m.root, { signKey: alice.me.rootKey, encKey: m.device.enc.publicKey });
      const e = event(mallory, randomId(), "thread.opened", { goal: "x", participants: [mallory.me.rootKey, bob.me.rootKey] }, 0, [], { author: deviceId(claimed) });
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e, credential: claimed, sig: alice.device.credential.sig }));
    },
  },
  {
    id: "ENV-13",
    category: "envelope",
    attacker: "contact",
    title: "Edit a credential without the root key",
    claim: "Changing any field of a credential invalidates it.",
    async run(ctx) {
      const { bob, alice } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const cred = mallory.device.credential;
      const spare = generateSigningKey();
      const spareEnc = (await identity()).device.enc.publicKey;
      const edits: [string, Record<string, unknown>, typeof spare?][] = [
        ["longer life", { ...cred, expiresAt: cred.expiresAt + 365 * DAY }],
        ["earlier issue date", { ...cred, issuedAt: cred.issuedAt - 1 }],
        ["later issue date", { ...cred, issuedAt: cred.issuedAt + 1 }],
        ["another encryption key", { ...cred, encKey: spareEnc }],
        ["another signing key", { ...cred, signKey: spare.publicKey }, spare],
        ["another root", { ...cred, rootKey: alice.me.rootKey }],
        ["version", { ...cred, v: 2 }],
        ["added field", { ...cred, admin: true }],
        ["field moved", (({ issuedAt: _, ...rest }) => ({ ...rest, issued: cred.issuedAt }))(cred)],
      ];
      for (const [name, edited, signer] of edits) {
        let author = mallory.me.device;
        try {
          author = deviceId(edited as never);
        } catch {
          // keep the real device id when the edit made the keys unusable
        }
        const e = event(mallory, randomId(), "contact.hello", {}, 0, [], { author });
        await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e, credential: edited, ...(signer ? { signer } : {}) }), name);
      }
      assert.deepEqual(bob.contact("mallory").credential, cred);
    },
  },
  {
    id: "ENV-14",
    category: "envelope",
    attacker: "contact",
    title: "Use a credential at and after its expiry",
    claim: "A credential stops working at the millisecond it expires, and not before.",
    async run(ctx) {
      const c = clock();
      const bob = await ctx.person({ now: c.now });
      const mallory = await ctx.contact(bob, "mallory", { now: c.now });
      const m = ctx.secrets(mallory);
      const t = c.now();
      const hello = (expiresAt: number) => {
        const credential = mint(m.root, { signKey: m.device.sign.publicKey, encKey: m.device.enc.publicKey, issuedAt: t - HOUR, expiresAt });
        return forge({ from: mallory, to: bob, event: event(mallory, randomId(), "contact.hello", {}, 0, [], { createdAt: t }), credential, expiresAt: t + 400 * DAY });
      };
      await ctx.refused(bob, await hello(t), "expires now");
      await ctx.refused(bob, await hello(t - 1), "expired a millisecond ago");
      await ctx.refused(bob, await hello(0), "expiry zero");
      assert.equal((await bob.receive(await hello(t + 1))).result, "applied");

      const late = await forge({ from: mallory, to: bob, event: event(mallory, randomId(), "contact.hello", {}, 0, [], { createdAt: t }), expiresAt: t + 400 * DAY });
      c.advance(mallory.device.credential.expiresAt - t);
      await ctx.refused(bob, late, "the paired credential, ninety days on");
    },
  },
  {
    id: "ENV-15",
    category: "envelope",
    attacker: "contact",
    title: "Date a credential in the future",
    claim: "A credential issued more than five minutes ahead of the receiver's clock is refused.",
    async run(ctx) {
      const c = clock();
      const bob = await ctx.person({ now: c.now });
      const mallory = await ctx.contact(bob, "mallory", { now: c.now });
      const m = ctx.secrets(mallory);
      const t = c.now();
      const hello = (issuedAt: number) => {
        const credential = mint(m.root, { signKey: m.device.sign.publicKey, encKey: m.device.enc.publicKey, issuedAt, expiresAt: t + 90 * DAY });
        return forge({ from: mallory, to: bob, event: event(mallory, randomId(), "contact.hello", {}, 0, [], { createdAt: t }), credential, expiresAt: t + HOUR });
      };
      await ctx.refused(bob, await hello(t + 5 * MINUTE + 1), "five minutes and a millisecond ahead");
      await ctx.refused(bob, await hello(t + 365 * DAY), "a year ahead");
      await ctx.refused(bob, await hello(Number.MAX_SAFE_INTEGER), "the largest date");
      assert.equal(bob.contact("mallory").credential.issuedAt, mallory.device.credential.issuedAt);
      assert.equal((await bob.receive(await hello(t + 5 * MINUTE))).result, "applied");
    },
  },
  {
    id: "ENV-16",
    category: "envelope",
    attacker: "relay",
    title: "Hold a message back until after it expires",
    claim: "A message delivered at or after its expiry is refused.",
    async run(ctx) {
      const c = clock();
      const { bob, alice, thread } = await scene(ctx, { now: c.now });
      const t = c.now();
      const onTime = await send(alice, bob, event(alice, thread, "talk.posted", { text: "on time" }, 1, [], { createdAt: t }), t + HOUR);
      const late = await send(alice, bob, event(alice, thread, "talk.posted", { text: "late" }, 2, [], { createdAt: t }), t + HOUR);
      c.advance(HOUR - 1);
      assert.equal((await bob.receive(onTime)).result, "applied");
      c.advance(1);
      await ctx.refused(bob, late);
      assert.deepEqual(ctx.texts(bob, thread), ["on time"]);
    },
  },
  {
    id: "ENV-17",
    category: "envelope",
    attacker: "contact",
    title: "Add to or cut from the sealed payload",
    claim: "The sealed payload holds an event, a signature and a credential, and nothing else.",
    async run(ctx) {
      const { bob } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const thread = await ctx.thread(mallory, "them", bob);
      const edits: [string, (i: Record<string, unknown>) => unknown][] = [
        ["added grant", (i) => ({ ...i, grant: { op: "read", resource: "*" } })],
        ["added second event", (i) => ({ ...i, events: [i.event] })],
        ["no credential", ({ credential: _, ...rest }) => rest],
        ["null credential", (i) => ({ ...i, credential: null })],
        ["credential as a list", (i) => ({ ...i, credential: [i.credential] })],
        ["signature as a list", (i) => ({ ...i, sig: [i.sig] })],
        ["short signature", (i) => ({ ...i, sig: (i.sig as string).slice(0, 85) })],
        ["empty signature", (i) => ({ ...i, sig: "" })],
        ["event as a list", (i) => ({ ...i, event: [i.event] })],
        ["payload as a list", (i) => [i.event, i.sig, i.credential]],
      ];
      for (const [name, inner] of edits) {
        await ctx.refused(bob, await forge({ from: mallory, to: bob, event: event(mallory, thread, "talk.posted", { text: "x" }, 1), inner }), name);
      }
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-18",
    category: "envelope",
    attacker: "relay",
    title: "Deliver an old message to roll a credential back",
    claim: "A contact's stored credential only moves forward, whatever order messages arrive in.",
    async run(ctx) {
      const c = clock();
      const { bob, alice, thread } = await scene(ctx, { now: c.now });
      const before = bob.contact("alice").credential;
      const stale = await send(alice, bob, event(alice, thread, "talk.posted", { text: "held back by the relay" }, 1), c.now() + 100 * DAY);
      c.advance(70 * DAY);
      assert.equal(await alice.renewIfDue(), true);
      await ctx.carry(alice, bob);
      const renewed = bob.contact("alice").credential;
      assert.ok(renewed.expiresAt > before.expiresAt);
      assert.equal((await bob.receive(stale)).result, "applied");
      assert.deepEqual(bob.contact("alice").credential, renewed);
    },
  },
  {
    id: "ENV-19",
    category: "envelope",
    attacker: "contact",
    title: "Date an event in the future",
    claim: "An event dated more than ten minutes ahead of the receiver's clock is refused.",
    async run(ctx) {
      const { bob } = await scene(ctx);
      const mallory = await ctx.contact(bob, "mallory");
      const thread = await ctx.thread(mallory, "them", bob);
      for (const createdAt of [Date.now() + 11 * MINUTE, Date.now() + 365 * DAY, 8_640_000_000_000_001, Number.MAX_SAFE_INTEGER]) {
        await ctx.refused(bob, await send(mallory, bob, event(mallory, thread, "talk.posted", { text: "from the future" }, 1, [], { createdAt })), String(createdAt));
      }
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "ENV-20",
    category: "envelope",
    attacker: "stranger",
    title: "Send a contact request with an unusable encryption key",
    claim: "A message that cannot be answered is refused and recorded like any other bad message.",
    async run(ctx) {
      const bob = await ctx.person();
      const stranger = await identity();
      const points: [string, Uint8Array][] = [
        ["all zero", new Uint8Array(32)],
        ["one", Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0))],
      ];
      for (const [name, point] of points) {
        const credential = mint(stranger.root, { signKey: stranger.device.sign.publicKey, encKey: b64u(point) });
        const e = event(stranger.device, randomId(), "contact.request", { token: randomId() }, 0, [], { author: deviceId(credential) });
        await ctx.refused(bob, await forge({ from: stranger.device, to: bob, event: e, credential }), name);
      }
      assert.deepEqual(bob.contacts(), []);
    },
  },
];
