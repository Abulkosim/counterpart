import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type PairMsg, InviterRun, JoinerRun, WORDS, b64u, codeWithRelay, encodePairMsg, generateSigningKey, issueDevice, looksLikeCode, pairAd, parseCode, parsePairMsg,
  randomWords, relayFromHint, relayHint, unb64u,
} from "../src/index.ts";

const RELAY = "wss://relay.example.com";
const person = async () => issueDevice(generateSigningKey());
const roundTrip = (m: PairMsg): PairMsg => parsePairMsg(encodePairMsg(m));

async function setup(words: [string, string] = ["acid", "zoom"], joinerWords = words, joinerRelay = RELAY) {
  const [a, b] = [await person(), await person()];
  const inviter = new InviterRun({ relay: RELAY, nameplate: 7, words, credential: a.credential });
  const joiner = new JoinerRun({ relay: joinerRelay, nameplate: 7, words: joinerWords, credential: b.credential });
  return { a, b, inviter, joiner };
}

test("codes: format, parse, typos refused before anything is sent", () => {
  assert.equal(WORDS.length, 1295);
  assert.ok(!WORDS.some((w) => w.includes("-")));
  assert.deepEqual(parseCode("7-acid-zoom"), { nameplate: 7, words: ["acid", "zoom"] });
  assert.deepEqual(parseCode("  7 Acid ZOOM "), { nameplate: 7, words: ["acid", "zoom"] });
  assert.deepEqual(parseCode("7-acid-zoom@relay.example.com"), { nameplate: 7, words: ["acid", "zoom"], relay: RELAY });
  assert.deepEqual(parseCode("12-acid-zoom@ws://127.0.0.1:7447"), { nameplate: 12, words: ["acid", "zoom"], relay: "ws://127.0.0.1:7447" });
  assert.throws(() => parseCode("7-acid-zoomm"), /not one of the code words/);
  assert.throws(() => parseCode("0-acid-zoom"), /between 1 and 9999/);
  assert.throws(() => parseCode("7-acid"), /a number and two words/);
  assert.throws(() => parseCode("7-acid-zoom@relay example"), /cannot be shown/);
  assert.ok(looksLikeCode("7-acid-zoom") && looksLikeCode("7 acid zoom@x") && !looksLikeCode("cpart-invite:abc"));
  for (const r of [RELAY, "wss://relay.example.com:8443/cpart", "ws://127.0.0.1:7447", "wss://h/", "wss://user@h"]) assert.equal(relayFromHint(relayHint(r)), r, r);
  assert.equal(relayHint(RELAY), "relay.example.com");
  assert.equal(codeWithRelay(7, ["acid", "zoom"], "ws://127.0.0.1:1"), "7-acid-zoom@ws://127.0.0.1:1");
  const w = randomWords();
  assert.ok(WORDS.includes(w[0]) && WORDS.includes(w[1]));
});

test("the same code: both sides confirm, and the invite crosses sealed", async () => {
  const { a, b, inviter, joiner } = await setup();
  const m1 = roundTrip(inviter.first());
  const j = joiner.answer(m1);
  assert.ok(j.ok);
  assert.equal(j.peer.rootKey, a.credential.rootKey);
  const i = inviter.answer(roundTrip(j.reply));
  assert.ok(i.ok);
  assert.equal(i.peer.rootKey, b.credential.rootKey);
  const m3 = roundTrip(i.finish("cpart-invite:secret-token"));
  assert.ok(!JSON.stringify(m3).includes("secret-token"));
  const f = joiner.finish(m3);
  assert.ok(f.ok);
  assert.equal(f.invite, "cpart-invite:secret-token");
});

test("a wrong code fails on the inviter's side, and the run is spent", async () => {
  const { inviter, joiner } = await setup(["acid", "zoom"], ["acid", "zone"]);
  const j = joiner.answer(inviter.first());
  assert.ok(j.ok);
  const i = inviter.answer(j.reply);
  assert.ok(!i.ok && i.why === "wrong-code");
  // A second answer, even a right one, is not looked at.
  const { joiner: honest } = await setup();
  const again = honest.answer(inviter.first());
  assert.ok(again.ok);
  const i2 = inviter.answer(again.reply);
  assert.ok(!i2.ok && i2.why === "refused");
});

test("a different relay or nameplate gives different keys", async () => {
  const { inviter, joiner } = await setup(["acid", "zoom"], ["acid", "zoom"], "wss://evil.example.com");
  const j = joiner.answer(inviter.first());
  assert.ok(j.ok);
  const i = inviter.answer(j.reply);
  assert.ok(!i.ok && i.why === "wrong-code");
});

test("substituted credentials, reflected and replayed messages are refused", async () => {
  const evil = await person();
  // The relay swaps the inviter's credential for its own and keeps the share.
  {
    const { inviter, joiner } = await setup();
    const m1 = inviter.first() as Extract<PairMsg, { k: "a" }>;
    const j = joiner.answer({ ...m1, ad: b64u(pairAd("inviter", evil.credential)) });
    assert.ok(j.ok);
    const i = inviter.answer(j.reply);
    assert.ok(!i.ok && i.why === "wrong-code");
  }
  // The relay swaps the joiner's credential in the answer.
  {
    const { inviter, joiner } = await setup();
    const j = joiner.answer(inviter.first());
    assert.ok(j.ok);
    const i = inviter.answer({ ...(j.reply as Extract<PairMsg, { k: "b" }>), ad: b64u(pairAd("joiner", evil.credential)) });
    assert.ok(!i.ok && i.why === "wrong-code");
  }
  // The inviter's first message reflected back as if it were the answer.
  {
    const { inviter } = await setup();
    const m1 = inviter.first() as Extract<PairMsg, { k: "a" }>;
    const i = inviter.answer({ v: 1, k: "b", y: m1.y, ad: m1.ad, tag: b64u(new Uint8Array(64)) });
    assert.ok(!i.ok && i.why === "bad-message");
  }
  // An answer from an earlier successful run replayed into a new one.
  {
    const old = await setup();
    const j = old.joiner.answer(old.inviter.first());
    assert.ok(j.ok);
    const fresh = new InviterRun({ relay: RELAY, nameplate: 7, words: ["acid", "zoom"], credential: old.a.credential });
    fresh.first();
    const i = fresh.answer(j.reply);
    assert.ok(!i.ok && i.why === "wrong-code");
  }
  // The identity element as a share.
  {
    const { inviter, joiner } = await setup();
    const m1 = inviter.first() as Extract<PairMsg, { k: "a" }>;
    const j = joiner.answer({ ...m1, y: b64u(new Uint8Array(32)) });
    assert.ok(!j.ok && j.why === "bad-message");
  }
});

test("the joiner checks the inviter's confirmation and the sealed box", async () => {
  {
    const { inviter, joiner } = await setup();
    const j = joiner.answer(inviter.first());
    assert.ok(j.ok);
    const i = inviter.answer(j.reply);
    assert.ok(i.ok);
    const m3 = i.finish("cpart-invite:x") as Extract<PairMsg, { k: "c" }>;
    const tag = unb64u(m3.tag);
    tag[0]! ^= 1;
    const f = joiner.finish({ ...m3, tag: b64u(tag) });
    assert.ok(!f.ok && f.why === "not-confirmed");
    assert.ok(!joiner.finish(m3).ok, "a second confirmation is not looked at");
  }
  {
    const { inviter, joiner } = await setup();
    const j = joiner.answer(inviter.first());
    assert.ok(j.ok);
    const i = inviter.answer(j.reply);
    assert.ok(i.ok);
    const m3 = i.finish("cpart-invite:x") as Extract<PairMsg, { k: "c" }>;
    const box = unb64u(m3.box);
    box[20]! ^= 1;
    const f = joiner.finish({ ...m3, box: b64u(box) });
    assert.ok(!f.ok && f.why === "bad-message");
  }
});

test("messages must be canonical and well formed", () => {
  for (const bad of ['{"k":"fail","v":1,"why":"nope"}', '{"k":"fail", "v":1,"why":"wrong-code"}', '{"k":"a","v":1}', "[]", "x".repeat(5000), '{"extra":1,"k":"fail","v":1,"why":"wrong-code"}']) {
    assert.throws(() => parsePairMsg(bad));
  }
  assert.deepEqual(parsePairMsg('{"k":"fail","v":1,"why":"wrong-code"}'), { v: 1, k: "fail", why: "wrong-code" });
});

test("your own code is refused", async () => {
  const a = await person();
  const inviter = new InviterRun({ relay: RELAY, nameplate: 7, words: ["acid", "zoom"], credential: a.credential });
  const joiner = new JoinerRun({ relay: RELAY, nameplate: 7, words: ["acid", "zoom"], credential: a.credential });
  const j = joiner.answer(inviter.first());
  assert.ok(!j.ok && j.why === "own-code");
});
