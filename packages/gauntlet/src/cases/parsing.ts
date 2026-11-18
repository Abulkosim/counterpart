import assert from "node:assert/strict";
import type { Counterpart } from "@counterpart/daemon";
import { b64u, canonicalBytes, concat, decodeInvite, encodeInvite, generateSigningKey, randomId, utf8 } from "@counterpart/protocol";
import { type Ctx, HOUR, event, forge, mint, respell, scene, send } from "../harness.ts";
import type { Case } from "../types.ts";

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function swap(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `test bug: ${from} not in payload`);
  return text.replace(from, to);
}
function spliceBytes(text: string, marker: string, bytes: number[]): Uint8Array {
  const b = Buffer.from(text);
  const i = b.indexOf(marker);
  assert.ok(i >= 0, `test bug: ${marker} not in payload`);
  return Buffer.concat([b.subarray(0, i), Buffer.from(bytes), b.subarray(i + marker.length)]);
}

// Mallory is a contact with a thread of her own, so only the malformed part stands between her message and Bob's log.
async function withMallory(ctx: Ctx): Promise<{ bob: Counterpart; mallory: Counterpart; thread: string }> {
  const bob = await ctx.person();
  const mallory = await ctx.contact(bob, "mallory");
  const thread = await ctx.thread(mallory, "them", bob);
  return { bob, mallory, thread };
}

export const parsing: Case[] = [
  {
    id: "PAR-01",
    category: "parsing",
    attacker: "contact",
    title: "Prefix signed bytes with a byte order mark",
    claim: "Input that is not byte for byte canonical is refused.",
    async run(ctx) {
      const { bob, mallory, thread } = await withMallory(ctx);
      const invite = { v: 1 as const, relay: bob.relay, credential: mallory.device.credential, token: randomId(), expiresAt: Date.now() + HOUR };
      const marked = "cpart-invite:" + b64u(concat(BOM, canonicalBytes(invite)));
      assert.ok(decodeInvite(encodeInvite(invite)));
      assert.throws(() => decodeInvite(marked), "an invite with a BOM was accepted");
      const e = event(mallory, thread, "talk.posted", { text: "marked" }, 1);
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e, plaintext: (c) => concat(BOM, utf8(c)) }));
    },
  },
  {
    id: "PAR-02",
    category: "parsing",
    attacker: "contact",
    title: "Repeat a JSON key with two different values",
    claim: "A payload with a duplicate key is refused, so no two readers can pick different values.",
    async run(ctx) {
      const { bob, mallory, thread } = await withMallory(ctx);
      // The signature is valid for the value a last-key-wins parser reads.
      const make = () => event(mallory, thread, "talk.posted", { text: "wire 500 to mallory" }, 1);
      const edits: [string, (c: string) => string][] = [
        ["text", (c) => swap(c, '"body":{"text":"wire 500 to mallory"}', '"body":{"text":"lunch on friday?","text":"wire 500 to mallory"}')],
        ["body", (c) => swap(c, '"body":{', '"body":{"text":"lunch on friday?"},"body":{')],
        ["type", (c) => swap(c, '"type":"talk.posted"', '"type":"contact.hello","type":"talk.posted"')],
        ["signature", (c) => swap(c, '"sig":"', `"sig":"${"A".repeat(86)}","sig":"`)],
      ];
      for (const [name, plaintext] of edits) await ctx.refused(bob, await forge({ from: mallory, to: bob, event: make(), plaintext }), name);
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "PAR-03",
    category: "parsing",
    attacker: "contact",
    title: "Spell the same payload another way",
    claim: "Only the canonical spelling of a payload is accepted: no spare whitespace, reordered keys, optional escapes or alternative number forms.",
    async run(ctx) {
      const { bob, mallory, thread } = await withMallory(ctx);
      const make = () => event(mallory, thread, "talk.posted", { text: "a/b \u001b ok" }, 1);
      const edits: [string, (c: string) => string][] = [
        ["leading space", (c) => ` ${c}`],
        ["trailing newline", (c) => `${c}\n`],
        ["space after a colon", (c) => swap(c, '"authorSeq":1', '"authorSeq": 1')],
        ["keys reordered", (c) => {
          const { credential, event: e, sig } = JSON.parse(c) as Record<string, unknown>;
          return JSON.stringify({ sig, event: e, credential });
        }],
        ["escaped letter", (c) => swap(c, '"text":"a/b', '"text":"\\u0061/b')],
        ["escaped slash", (c) => swap(c, '"text":"a/b', '"text":"a\\/b')],
        ["upper case escape", (c) => swap(c, "\\u001b", "\\u001B")],
        ["decimal point", (c) => swap(c, '"authorSeq":1', '"authorSeq":1.0')],
        ["exponent", (c) => swap(c, '"authorSeq":1', '"authorSeq":1e0')],
        ["decimal credential version", (c) => swap(c, '"v":1', '"v":1.0')],
      ];
      for (const [name, plaintext] of edits) await ctx.refused(bob, await forge({ from: mallory, to: bob, event: make(), plaintext }), name);
      const zero = await forge({ from: mallory, to: bob, event: event(mallory, randomId(), "contact.hello", {}, 0), plaintext: (c) => swap(c, '"authorSeq":0', '"authorSeq":-0') });
      await ctx.refused(bob, zero, "negative zero");
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "PAR-04",
    category: "parsing",
    attacker: "contact",
    title: "Use fractions, negatives and oversized numbers",
    claim: "Every number is a non-negative safe integer, or the message is refused.",
    async run(ctx) {
      const { bob, mallory, thread } = await withMallory(ctx);
      const make = () => event(mallory, thread, "talk.posted", { text: "numbers" }, 1);
      for (const n of ["1.5", "-1", "9007199254740992", "1e400", "-9007199254740991", "0.1e1", "true", '"1"', "null", "[1]"]) {
        await ctx.refused(bob, await forge({ from: mallory, to: bob, event: make(), plaintext: (c) => swap(c, '"authorSeq":1', `"authorSeq":${n}`) }), `authorSeq ${n}`);
      }
      for (const n of ["-5", "1.5", "1e400"]) {
        await ctx.refused(bob, await forge({ from: mallory, to: bob, event: make(), plaintext: (c) => c.replace(/"createdAt":\d+/, `"createdAt":${n}`) }), `createdAt ${n}`);
      }
      const good = await send(mallory, bob, make());
      for (const expiresAt of [-1, 1.5, Date.now() + HOUR + 0.5, "9999999999999", null, Number.MAX_VALUE]) {
        await ctx.refused(bob, { ...good, header: { ...good.header, expiresAt } }, `header expiry ${expiresAt}`);
      }
      const m = ctx.secrets(mallory);
      const keys = { signKey: m.device.sign.publicKey, encKey: m.device.enc.publicKey };
      for (const fields of [{ expiresAt: -1 }, { issuedAt: -1 }]) {
        await ctx.refused(bob, await forge({ from: mallory, to: bob, event: make(), credential: mint(m.root, { ...keys, ...fields }) }), `credential ${JSON.stringify(fields)}`);
      }
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "PAR-05",
    category: "parsing",
    attacker: "contact",
    title: "Send text that is not well-formed Unicode",
    claim: "Unpaired surrogates and invalid UTF-8 are refused, not repaired.",
    async run(ctx) {
      const { bob, mallory, thread } = await withMallory(ctx);
      const make = () => event(mallory, thread, "talk.posted", { text: "MARK" }, 1);
      const bytes: [string, number[]][] = [
        ["stray byte", [0xff]],
        ["overlong NUL", [0xc0, 0x80]],
        ["encoded surrogate", [0xed, 0xa0, 0x80]],
        ["truncated sequence", [0xe2, 0x82]],
        ["raw control byte", [0x1b]],
      ];
      for (const [name, b] of bytes) await ctx.refused(bob, await forge({ from: mallory, to: bob, event: make(), plaintext: (c) => spliceBytes(c, "MARK", b) }), name);
      for (const esc of ["\\ud800", "\\udc00\\ud800", "\\ud83d"]) {
        await ctx.refused(bob, await forge({ from: mallory, to: bob, event: make(), plaintext: (c) => swap(c, "MARK", esc) }), `escaped ${esc}`);
      }
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "PAR-06",
    category: "parsing",
    attacker: "contact",
    title: "Smuggle __proto__ and constructor keys",
    claim: "Keys that name JavaScript internals are treated as unknown fields and refused, and nothing leaks into shared prototypes.",
    async run(ctx) {
      const { bob, mallory, thread } = await withMallory(ctx);
      const base = () => event(mallory, thread, "talk.posted", { text: "x" }, 1);
      const j = (s: string): unknown => JSON.parse(s);
      const events: [string, unknown][] = [
        ["__proto__ on the event", { ...base(), ...(j('{"__proto__":{"polluted":true}}') as object) }],
        ["text supplied through __proto__", { ...base(), body: j('{"__proto__":{"text":"x"}}') }],
        ["__proto__ beside text", { ...base(), body: j('{"__proto__":{"polluted":true},"text":"x"}') }],
        ["constructor.prototype in the body", { ...base(), body: { text: "x", constructor: { prototype: { polluted: true } } } }],
        ["type __proto__", { ...base(), type: "__proto__" }],
        ["type constructor", { ...base(), type: "constructor" }],
        ["type toString", { ...base(), type: "toString", lane: undefined }],
        ["type hasOwnProperty", { ...base(), type: "hasOwnProperty" }],
      ];
      for (const [name, e] of events) {
        const clean = JSON.parse(JSON.stringify(e)) as unknown;
        await ctx.refused(bob, await forge({ from: mallory, to: bob, event: clean }), name);
      }
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: base(), inner: (i) => ({ ...i, ...(j('{"__proto__":{"polluted":true}}') as object) }) }), "__proto__ on the payload");
      const cred = mallory.device.credential;
      const { issuedAt: _, ...rest } = cred;
      await ctx.refused(bob, await forge({ from: mallory, to: bob, event: base(), credential: { ...rest, ...(j(`{"__proto__":{"issuedAt":${cred.issuedAt}}}`) as object) } }), "credential field through __proto__");

      const good = await send(mallory, bob, base());
      await ctx.refused(bob, j(`{"__proto__":${JSON.stringify(good)}}`), "whole wire inside __proto__");
      await ctx.refused(bob, { ...good, ...(j('{"__proto__":{"polluted":true}}') as object) }, "__proto__ on the wire");
      await ctx.refused(bob, { ...good, header: { ...good.header, ...(j('{"__proto__":{"polluted":true}}') as object) } }, "__proto__ on the header");
      await ctx.refused(bob, { ...good, header: { ...good.header, constructor: "x" } }, "constructor on the header");

      assert.equal(({} as Record<string, unknown>).polluted, undefined);
      assert.equal(Object.keys(Object.prototype).length, 0);
      assert.equal((await bob.receive(good)).result, "applied");
    },
  },
  {
    id: "PAR-07",
    category: "parsing",
    attacker: "contact",
    title: "Invent event types and cross lanes",
    claim: "Only the listed event types are accepted, each in its own lane.",
    async run(ctx) {
      const { bob, mallory, thread } = await withMallory(ctx);
      const variants: Record<string, unknown>[] = [
        { type: "act.grant", lane: "act", body: { op: "read", resource: "*" } },
        { type: "contract.accepted", lane: "act", body: { hash: "x" } },
        { type: "human.approved", lane: "control", body: {} },
        { type: "", lane: "talk" },
        { type: "talk.posted\u0000", lane: "talk" },
        { type: "TALK.POSTED" },
        { type: ["talk.posted"] },
        { lane: "control" },
        { lane: "act" },
        { lane: "" },
        { type: "contact.hello", lane: "talk", body: {} },
        { body: { text: "x", approve: true } },
        { body: { text: "x", grant: { resource: "/etc/passwd" } } },
        { body: "x" },
        { body: ["x"] },
        { body: null },
        { approved: true },
        { human: bob.me.human },
      ];
      for (const over of variants) {
        const e = event(mallory, thread, "talk.posted", { text: "x" }, 1, [], over);
        await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e }), JSON.stringify(over));
      }
      assert.deepEqual(ctx.texts(bob, thread), []);
    },
  },
  {
    id: "PAR-08",
    category: "parsing",
    attacker: "contact",
    title: "Go one past every size limit",
    claim: "Over-limit text, goals, parent lists and identifiers are refused whole, never truncated.",
    async run(ctx) {
      const { bob, mallory, thread } = await withMallory(ctx);
      const ids = (n: number): string[] => Array.from({ length: n }, () => randomId());
      const talk = (over: Record<string, unknown>) => event(mallory, thread, "talk.posted", { text: "x" }, 1, [], over);
      const open = (body: Record<string, unknown>) => event(mallory, randomId(), "thread.opened", body as never, 0);
      const two = [mallory.me.rootKey, bob.me.rootKey];
      const events: [string, unknown][] = [
        ["text one over", talk({ body: { text: "a".repeat(16001) } })],
        ["empty text", talk({ body: { text: "" } })],
        ["seventeen parents", talk({ parents: ids(17) })],
        ["repeated parent", talk({ parents: [bob.log(thread)[0]!.id, bob.log(thread)[0]!.id] })],
        ["short id", talk({ id: "abc" })],
        ["long id", talk({ id: "a".repeat(65) })],
        ["path as id", talk({ id: "../../../../etc/passwd" })],
        ["id with a space", talk({ id: `${randomId()} x` })],
        ["thread id with a newline", talk({ threadId: `${randomId()}\n` })],
        ["goal one over", open({ goal: "g".repeat(2001), participants: two })],
        ["nine participants", open({ goal: "g", participants: [...two, ...ids(7).map(() => generateSigningKey().publicKey)] })],
        ["short key as participant", open({ goal: "g", participants: [mallory.me.rootKey, bob.me.rootKey.slice(1)] })],
      ];
      const before = bob.threads().length;
      for (const [name, e] of events) await ctx.refused(bob, await forge({ from: mallory, to: bob, event: e }), name);
      assert.equal(bob.threads().length, before);
      const max = event(mallory, thread, "talk.posted", { text: "a".repeat(16000) }, 1);
      assert.equal((await bob.receive(await send(mallory, bob, max))).result, "applied");
      assert.equal(ctx.texts(bob, thread)[0]!.length, 16000);
    },
  },
  {
    id: "PAR-09",
    category: "parsing",
    attacker: "contact",
    title: "Exhaust the parser with depth and size",
    claim: "Deeply nested or very large payloads are refused quickly and the daemon keeps working.",
    async run(ctx) {
      const { bob, mallory, thread } = await withMallory(ctx);
      const deep = (n: number, open = "[", close = "]"): string => open.repeat(n) + close.repeat(n);
      const make = () => event(mallory, thread, "talk.posted", { text: "MARK" }, 1);
      const payloads: [string, (c: string) => string][] = [
        ["100,000 nested lists", () => deep(100_000)],
        ["60,000 nested objects", () => '{"a":'.repeat(60_000) + "1" + "}".repeat(60_000)],
        ["nested lists inside the body", (c) => swap(c, '"MARK"', deep(100_000))],
        ["nested lists as parents", (c) => swap(c, '"parents":[]', `"parents":${deep(100_000)}`)],
        ["25,000 keys", () => `{${Array.from({ length: 25_000 }, (_, i) => `"k${String(i).padStart(5, "0")}":0`).join(",")}}`],
        ["350 KB string", (c) => swap(c, "MARK", "A".repeat(350_000))],
        ["350 KB of digits", (c) => swap(c, '"authorSeq":1', `"authorSeq":${"9".repeat(350_000)}`)],
      ];
      const started = Date.now();
      for (const [name, plaintext] of payloads) await ctx.refused(bob, await forge({ from: mallory, to: bob, event: make(), plaintext }), name);
      const good = await send(mallory, bob, make());
      await ctx.refused(bob, { ...good, ct: "A".repeat(2_000_000) }, "2 MB ciphertext");
      await ctx.refused(bob, { ...good, header: JSON.parse(deep(5000)) as unknown }, "nested header");
      await ctx.refused(bob, { ...good, enc: JSON.parse(deep(5000)) as unknown }, "nested key");
      assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
      assert.equal((await bob.receive(good)).result, "applied");
    },
  },
  {
    id: "PAR-10",
    category: "parsing",
    attacker: "stranger",
    title: "Hand over a hostile invite",
    claim: "A malformed, oversized or tampered invite is refused before anything is stored or sent.",
    async run(ctx) {
      const bob = await ctx.person();
      const mallory = await ctx.person();
      const real = { v: 1 as const, relay: bob.relay, credential: mallory.device.credential, token: randomId(), expiresAt: Date.now() + HOUR };
      const enc = (x: unknown): string => "cpart-invite:" + b64u(canonicalBytes(x));
      const raw = (s: string): string => "cpart-invite:" + b64u(utf8(s));
      const text = new TextDecoder().decode(canonicalBytes(real));
      const invites: [string, string][] = [
        ["nested lists", raw("[".repeat(200_000) + "]".repeat(200_000))],
        ["5 MB string", raw(JSON.stringify("A".repeat(5_000_000)))],
        ["duplicate token", raw(swap(text, '"token":"', `"token":"${randomId()}","token":"`))],
        ["trailing data", raw(`${text}{}`)],
        ["not base64", "cpart-invite:!!!!"],
        ["empty", "cpart-invite:"],
        ["wrong prefix", enc(real).replace("cpart-invite:", "cpart-invite/")],
        ["extra field", enc({ ...real, name: "alice", autoAccept: true })],
        ["http relay", enc({ ...real, relay: "http://127.0.0.1:9" })],
        ["javascript relay", enc({ ...real, relay: "javascript:alert(1)" })],
        ["file relay", enc({ ...real, relay: "file:///etc/passwd" })],
        ["another relay", enc({ ...real, relay: "ws://relay.attacker.example" })],
        ["expired", enc({ ...real, expiresAt: Date.now() - 1 })],
        ["float expiry", raw(text.replace(/"expiresAt":\d+,"relay"/, '"expiresAt":1e300,"relay"'))],
        ["credential with swapped encryption key", enc({ ...real, credential: { ...real.credential, encKey: bob.device.credential.encKey } })],
        ["credential with a longer life", enc({ ...real, credential: { ...real.credential, expiresAt: real.credential.expiresAt + 1 } })],
        ["expired credential", enc({ ...real, credential: mint(ctx.secrets(mallory).root, { signKey: real.credential.signKey, encKey: real.credential.encKey, expiresAt: Date.now() - 1 }) })],
        ["own invite", bob.createInvite("me")],
      ];
      const before = ctx.snapshot(bob);
      const started = Date.now();
      for (const [name, invite] of invites) await assert.rejects(bob.acceptInvite(invite, "alice"), `${name}: accepted`);
      assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
      assert.equal(ctx.snapshot(bob), before);
      assert.equal((await bob.acceptInvite(enc(real), "alice")).state, "pending");
      // The same relay spelled another way is the same relay: logins and routing
      // compare addresses normalized, so the request goes where Bob reads.
      const trent = await ctx.person();
      const respelled = enc({ ...real, relay: `${bob.relay}/`, credential: trent.device.credential, token: randomId() });
      assert.equal((await bob.acceptInvite(respelled, "trent")).state, "pending");
      assert.deepEqual(bob.relayBook.route([`${bob.relay}/`]).preferred, [bob.relay]);
    },
  },
  {
    id: "PAR-11",
    category: "parsing",
    attacker: "relay",
    title: "Respell base64 without changing the bytes",
    claim: "Keys, signatures and ciphertext have one accepted spelling each.",
    async run(ctx) {
      const { bob, alice, thread } = await scene(ctx);
      const first = await send(alice, bob, event(alice, thread, "talk.posted", { text: "one" }, 1));
      const enc = respell(first.enc);
      assert.ok(enc && enc !== first.enc);
      await ctx.refused(bob, { ...first, enc }, "encapsulated key");
      const m = await ctx.contact(bob, "mallory");
      const hello = event(m, randomId(), "contact.hello", {});
      await ctx.refused(bob, await forge({ from: m, to: bob, event: hello, inner: (i) => ({ ...i, sig: respell(i.sig as string) }) }), "signature");
    },
  },
];
