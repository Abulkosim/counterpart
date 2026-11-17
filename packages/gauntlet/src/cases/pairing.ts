// Short-code pairing (docs/pairing.md). Two real daemons run the pairing
// engine over a real relay, or over a relay the attacker runs. The rule under
// test throughout: without the code's words nobody pairs, a wrong guess ends
// the code for everyone, each side looks at one answer per code, and both
// people are told.
import assert from "node:assert/strict";
import { type Counterpart, PairingEngine, PairingStore, type PairingView } from "@counterpart/daemon";
import {
  type DeviceCredential, type PairCode, type PairMsg, InviterRun, JoinerRun, b64u, encodePairMsg, pairAd, parseCode, parsePairMsg, randomWords,
} from "@counterpart/protocol";
import { type Client, type Ctx, type EvilConn, HOUR, identity, until } from "../harness.ts";
import type { Case } from "../types.ts";

interface Person {
  node: Counterpart;
  store: PairingStore;
}

// Everyone gets a daemon link and a pairing engine. Engines and stores are
// stopped when `fn` ends, whatever happens.
async function withPeople<T>(ctx: Ctx, relayUrl: string, n: number, fn: (p: Person[]) => Promise<T>): Promise<T> {
  const people: Person[] = [];
  const stops: (() => unknown)[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const node = await ctx.person({ relay: relayUrl });
      const link = ctx.connect(node);
      const engine = new PairingEngine(node, link, { pollMs: 15 }).start();
      if (process.env.GAUNTLET_TRACE) engine.onLine = (l) => console.log(`         [${i}] ${l}`);
      const store = new PairingStore(node.home);
      stops.push(() => engine.stop(), () => store.close());
      people.push({ node, store });
    }
    return await fn(people);
  } finally {
    for (const s of stops) await s();
  }
}

async function invite(p: Person, name: string): Promise<{ id: string; code: PairCode }> {
  const id = p.store.requestInvite(name, p.node.relay);
  let v: PairingView | undefined;
  await until("a code", () => !!(v = p.store.get(id))?.code, 6000);
  return { id, code: parseCode(v!.code!) };
}
const ended = (p: Person, id: string): Promise<PairingView> =>
  until(`pairing ${id.slice(0, 6)} to end`, () => ["failed", "done"].includes(p.store.get(id)!.state), 6000).then(() => p.store.get(id)!);
const otherWords = (c: PairCode): PairCode => ({ ...c, words: [c.words[0], c.words[1] === "acid" ? "zoom" : "acid"] });

// A device that speaks the nameplate frames itself, outside any daemon.
async function rawJoiner(ctx: Ctx, url: string): Promise<{ c: Client; credential: DeviceCredential }> {
  const me = await identity();
  return { c: await ctx.login(me.device, url), credential: me.device.credential };
}
const frame = (f: unknown): Record<string, unknown> => f as Record<string, unknown>;

// A relay the attacker runs. It logs daemons in and implements nameplates,
// and `tamper` sees every pair.send before it is passed on.
function fakeRelay(tamper: (from: "inviter" | "joiner", body: string) => string[]) {
  const state = { owner: null as EvilConn | null, joiner: null as EvilConn | null, toJoiner: [] as string[], toInviter: [] as string[], n: { inviter: 0, joiner: 0 } };
  const deliver = (to: EvilConn | null, from: "inviter" | "joiner", body: string): void => {
    to?.send({ t: "pair.msg", nameplate: 5, from, n: state.n[from]++, body });
  };
  const onConn = (c: EvilConn): void => {
    c.send({ t: "challenge", nonce: "n".repeat(32) });
    c.ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (f.t === "auth") c.send({ t: "ready", device: "d_x" });
      else if (f.t === "pair.open") {
        state.owner = c;
        c.send({ t: "pair.opened", ref: f.ref, nameplate: 5, expiresAt: Date.now() + 600_000 });
      } else if (f.t === "pair.claim") {
        state.joiner = c;
        c.send({ t: "pair.claimed", nameplate: 5, expiresAt: Date.now() + 600_000 });
        for (const b of state.toJoiner) deliver(c, "inviter", b);
      } else if (f.t === "pair.send") {
        const from = c === state.owner ? "inviter" : "joiner";
        for (const b of tamper(from, f.body as string)) {
          if (from === "inviter") {
            state.toJoiner.push(b);
            deliver(state.joiner, "inviter", b);
          } else deliver(state.owner, "joiner", b);
        }
      }
    });
  };
  return { onConn, state };
}

export const pairing: Case[] = [
  {
    id: "PAIR-01",
    category: "pairing",
    attacker: "stranger",
    title: "Enter a code with one wrong word",
    claim: "A wrong code pairs nobody, fails on both sides with a plain sentence, and the right code no longer works afterwards.",
    async run(ctx) {
      const relay = await ctx.relay();
      await withPeople(ctx, relay.url, 3, async ([alice, mallory, bob]) => {
        const { id, code } = await invite(alice!, "bob");
        const j = mallory!.store.requestJoin(otherWords(code), "alice", relay.url);
        const [a, m] = [await ended(alice!, id), await ended(mallory!, j)];
        assert.equal(a.state, "failed");
        assert.match(a.detail!, /Someone tried a wrong code\. Nothing was paired/);
        assert.equal(m.state, "failed");
        assert.match(m.detail!, /The code did not match\. Nothing was paired/);
        const late = bob!.store.requestJoin(code, "alice", relay.url);
        assert.equal((await ended(bob!, late)).state, "failed");
        for (const p of [alice!, mallory!, bob!]) assert.deepEqual(p.node.contacts(), []);
      });
    },
  },
  {
    id: "PAIR-02",
    category: "pairing",
    attacker: "stranger",
    title: "Take the nameplate before the real joiner and guess",
    claim: "Someone who claims the number first gets one guess; it burns the code, and the real joiner is told the code was used, not paired with them.",
    async run(ctx) {
      const relay = await ctx.relay();
      await withPeople(ctx, relay.url, 2, async ([alice, bob]) => {
        const { id, code } = await invite(alice!, "bob");
        const { c, credential } = await rawJoiner(ctx, relay.url);
        c.send({ t: "pair.claim", nameplate: code.nameplate });
        await c.next("pair.claimed");
        const a = parsePairMsg(frame(await c.next("pair.msg")).body);
        // The squatter's guess, made exactly as an honest joiner would.
        const run = new JoinerRun({ relay: relay.url, nameplate: code.nameplate, words: randomWords(), credential });
        const step = run.answer(a);
        assert.ok(step.ok);
        const j = bob!.store.requestJoin(code, "alice", relay.url);
        const b = await ended(bob!, j);
        assert.equal(b.state, "failed");
        assert.match(b.detail!, /already used|No code with that number/);
        c.send({ t: "pair.send", nameplate: code.nameplate, body: encodePairMsg(step.reply) });
        const v = await ended(alice!, id);
        assert.match(v.detail!, /wrong code/);
        assert.equal(parsePairMsg(frame(await c.next("pair.msg")).body).k, "fail");
        assert.deepEqual(alice!.node.contacts(), []);
      });
    },
  },
  {
    id: "PAIR-03",
    category: "pairing",
    attacker: "contact",
    title: "Replay an answer from an earlier pairing",
    claim: "A joiner's answer that worked for one code is refused for the next, and that code is burned.",
    async run(ctx) {
      const relay = await ctx.relay();
      await withPeople(ctx, relay.url, 1, async ([alice]) => {
        // Mallory pairs honestly once, keeping her messages.
        const first = await invite(alice!, "mallory");
        const { c, credential } = await rawJoiner(ctx, relay.url);
        c.send({ t: "pair.claim", nameplate: first.code.nameplate });
        const run = new JoinerRun({ relay: relay.url, nameplate: first.code.nameplate, words: first.code.words, credential });
        const step = run.answer(parsePairMsg(frame(await c.next("pair.msg")).body));
        assert.ok(step.ok);
        c.send({ t: "pair.send", nameplate: first.code.nameplate, body: encodePairMsg(step.reply) });
        const fin = run.finish(parsePairMsg(frame(await c.next("pair.msg")).body));
        assert.ok(fin.ok, "the first pairing was honest and should confirm");
        // The next code is meant for dave. Mallory replays her old answer.
        const second = await invite(alice!, "dave");
        c.send({ t: "pair.claim", nameplate: second.code.nameplate });
        await c.next("pair.claimed");
        c.send({ t: "pair.send", nameplate: second.code.nameplate, body: encodePairMsg(step.reply) });
        const v = await ended(alice!, second.id);
        assert.equal(v.state, "failed");
        assert.match(v.detail!, /wrong code/);
        assert.ok(!alice!.node.contacts().some((x) => x.name === "dave"));
      });
    },
  },
  {
    id: "PAIR-04",
    category: "pairing",
    attacker: "stranger",
    title: "Reflect the inviter's own message back to it",
    claim: "The inviter refuses its own first message sent back as the answer, and the code is burned.",
    async run(ctx) {
      const relay = await ctx.relay();
      await withPeople(ctx, relay.url, 1, async ([alice]) => {
        const { id, code } = await invite(alice!, "bob");
        const { c } = await rawJoiner(ctx, relay.url);
        c.send({ t: "pair.claim", nameplate: code.nameplate });
        const a = parsePairMsg(frame(await c.next("pair.msg")).body) as Extract<PairMsg, { k: "a" }>;
        // Same share, same details, relabelled as an answer. Nothing else can be made without the words.
        c.send({ t: "pair.send", nameplate: code.nameplate, body: encodePairMsg({ v: 1, k: "b", y: a.y, ad: a.ad, tag: b64u(new Uint8Array(64)) }) });
        const v = await ended(alice!, id);
        assert.equal(v.state, "failed");
        assert.match(v.detail!, /malformed or tampered/);
        assert.deepEqual(alice!.node.contacts(), []);
      });
    },
  },
  {
    id: "PAIR-05",
    category: "pairing",
    attacker: "relay",
    title: "Swap the inviter's credential for the relay's own",
    claim: "A relay that replaces either side's details in transit makes the keys differ: both sides fail, both are told, and nobody pairs.",
    async run(ctx) {
      const evil = await identity();
      const fake = fakeRelay((from, body) => {
        const m = parsePairMsg(body);
        if (from === "inviter" && m.k === "a") return [encodePairMsg({ ...m, ad: b64u(pairAd("inviter", evil.device.credential)) })];
        return [body];
      });
      const r = await ctx.evilRelay(fake.onConn);
      await withPeople(ctx, r.url, 2, async ([alice, bob]) => {
        const { id, code } = await invite(alice!, "bob");
        const j = bob!.store.requestJoin(code, "alice", r.url);
        const [a, b] = [await ended(alice!, id), await ended(bob!, j)];
        assert.equal(a.state, "failed");
        assert.equal(b.state, "failed");
        assert.match(a.detail!, /wrong code/);
        assert.match(b.detail!, /did not match/);
        assert.deepEqual(alice!.node.contacts(), []);
        assert.deepEqual(bob!.node.contacts(), []);
      });
    },
  },
  {
    id: "PAIR-06",
    category: "pairing",
    attacker: "relay",
    title: "Send the inviter many guesses for one code",
    claim: "However many answers a relay delivers for one code, the inviter looks at the first only, so the relay gets one guess.",
    async run(ctx) {
      const guesses: string[] = [];
      let honest = "";
      const fake = fakeRelay((from, body) => {
        if (from === "joiner" && parsePairMsg(body).k === "b") {
          honest = body;
          // Ten made-up answers first, then the real one.
          return [...guesses, body];
        }
        return [body];
      });
      const r = await ctx.evilRelay(fake.onConn);
      await withPeople(ctx, r.url, 2, async ([alice, bob]) => {
        const { id, code } = await invite(alice!, "bob");
        await until("alice's first message at the relay", () => fake.state.toJoiner.length > 0);
        const a = parsePairMsg(fake.state.toJoiner[0]!);
        for (let i = 0; i < 10; i++) {
          const g = new JoinerRun({ relay: r.url, nameplate: 5, words: randomWords(), credential: (await identity()).device.credential }).answer(a);
          assert.ok(g.ok);
          guesses.push(encodePairMsg(g.reply));
        }
        const j = bob!.store.requestJoin(code, "alice", r.url);
        const v = await ended(alice!, id);
        assert.ok(honest, "bob answered");
        assert.equal(v.state, "failed", "the honest answer came after a guess and must not be looked at");
        await ended(bob!, j);
        assert.deepEqual(alice!.node.contacts(), []);
      });
    },
  },
  {
    id: "PAIR-07",
    category: "pairing",
    attacker: "relay",
    title: "Send the joiner a second first message",
    claim: "The joiner answers one first message per code; a second one from the relay, and a second try of the same code from the same home, get nothing.",
    async run(ctx) {
      let sent = 0;
      const fake = fakeRelay((from, body) => {
        if (from === "joiner") sent++;
        return [body];
      });
      const r = await ctx.evilRelay(fake.onConn);
      await withPeople(ctx, r.url, 2, async ([alice, bob]) => {
        const { code } = await invite(alice!, "bob");
        // The relay's own first message goes ahead of the real one.
        const ev = await identity();
        fake.state.toJoiner.unshift(encodePairMsg(new InviterRun({ relay: r.url, nameplate: 5, words: randomWords(), credential: ev.device.credential }).first()));
        const j = bob!.store.requestJoin(code, "alice", r.url);
        const b = await ended(bob!, j);
        assert.equal(b.state, "failed");
        assert.equal(sent, 1, "bob answered once and then stopped");
        assert.throws(() => bob!.store.requestJoin(code, "alice", r.url), /already tried here/);
        assert.deepEqual(bob!.node.contacts(), []);
      });
    },
  },
  {
    id: "PAIR-08",
    category: "pairing",
    attacker: "stranger",
    title: "Claim a nameplate again after it was used, or after it failed",
    claim: "A number that paired or failed cannot be claimed again, and the relay does not hand it out again while old codes may still be about.",
    async run(ctx) {
      const relay = await ctx.relay();
      await withPeople(ctx, relay.url, 3, async ([alice, bob, carol]) => {
        const ok = await invite(alice!, "bob");
        const jb = bob!.store.requestJoin(ok.code, "alice", relay.url);
        assert.equal((await ended(bob!, jb)).state, "done");
        const bad = await invite(alice!, "carol");
        const jc = carol!.store.requestJoin(otherWords(bad.code), "alice", relay.url);
        assert.equal((await ended(carol!, jc)).state, "failed");
        const { c } = await rawJoiner(ctx, relay.url);
        for (const n of [ok.code.nameplate, bad.code.nameplate]) {
          // The close may still be on its way; until then the number is merely taken.
          let code = "";
          for (let i = 0; i < 4 && code !== "nameplate_unknown"; i++) {
            if (i) await new Promise((res) => setTimeout(res, 100));
            c.send({ t: "pair.claim", nameplate: n });
            code = frame(await c.next("pair.error")).code as string;
            assert.ok(["nameplate_unknown", "nameplate_taken"].includes(code), code);
          }
          assert.equal(code, "nameplate_unknown");
        }
        for (const name of ["d1", "d2", "d3"]) {
          const again = await invite(alice!, name);
          assert.ok(![ok.code.nameplate, bad.code.nameplate].includes(again.code.nameplate), "a used number came back");
        }
      });
    },
  },
  {
    id: "PAIR-09",
    category: "pairing",
    attacker: "stranger",
    title: "Scan nameplate numbers from one device",
    claim: "One device can claim at most ten nameplates an hour, so scanning numbers for open codes stops quickly.",
    async run(ctx) {
      const relay = await ctx.relay();
      const { c } = await rawJoiner(ctx, relay.url);
      for (let n = 1; n <= 10; n++) {
        c.send({ t: "pair.claim", nameplate: n });
        assert.equal(frame(await c.next("pair.error")).code, "nameplate_unknown");
      }
      c.send({ t: "pair.claim", nameplate: 11 });
      assert.equal(frame(await c.next("pair.error")).code, "rate_limited");
    },
  },
  {
    id: "PAIR-11",
    category: "pairing",
    attacker: "network",
    title: "Lose the joiner's answer together with its connection",
    claim: "A pairing message lost with a dropped connection is sent again after the reconnect, once, and the pairing completes.",
    async run(ctx) {
      let answers = 0;
      let joinerConn: EvilConn | null = null;
      const fake = fakeRelay((from, body) => {
        if (from === "joiner" && parsePairMsg(body).k === "b" && answers++ === 0) {
          joinerConn?.ws.terminate();
          return [];
        }
        return [body];
      });
      const r = await ctx.evilRelay((c) => {
        fake.onConn(c);
        c.ws.on("message", (raw) => {
          if ((JSON.parse(raw.toString()) as { t: string }).t === "pair.claim") joinerConn = c;
        });
      });
      await withPeople(ctx, r.url, 2, async ([alice, bob]) => {
        const { id, code } = await invite(alice!, "bob");
        const j = bob!.store.requestJoin(code, "alice", r.url);
        // This relay carries pairing frames only, so the ordinary contact
        // request never arrives. Both sides proving the code is the point.
        await until("both sides to confirm", () => alice!.store.get(id)!.state === "confirmed" && bob!.store.get(j)!.state === "confirmed", 6000);
        assert.equal(answers, 2, "the answer was sent again exactly once");
      });
    },
  },
  {
    id: "PAIR-10",
    category: "pairing",
    attacker: "stranger",
    title: "Use a code-made invite from another identity",
    claim: "The invite sealed after a code is accepted only from the root key that proved the code.",
    async run(ctx) {
      const alice = await ctx.person();
      const bob = await ctx.person({ relay: alice.relay });
      const mallory = await ctx.person({ relay: alice.relay });
      const inv = alice.createInvite("bob", HOUR, bob.me.rootKey);
      await mallory.acceptInvite(inv, "alice");
      const wire = mallory.queued()[0]!;
      await ctx.refused(alice, wire, "a code-made invite used by someone else");
      assert.deepEqual(alice.contacts(), []);
      await bob.acceptInvite(inv, "alice");
      await ctx.carry(bob, alice);
      assert.equal(alice.contact("bob").rootKey, bob.me.rootKey);
    },
  },
];
