import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type ThreadEvent, b64u, canonicalBytes, canonicalize, hpke, decodeInvite, deviceId, encodeInvite, generateSigningKey, issueDevice,
  open, parseCanonical, parseEvent, randomId, safetyCode, seal, sign, unb64u, utf8, verify, verifyCredential,
} from "../src/index.ts";

const HOUR = 3600_000;

async function pair() {
  const aliceRoot = generateSigningKey();
  const bobRoot = generateSigningKey();
  return { aliceRoot, bobRoot, alice: await issueDevice(aliceRoot), bob: await issueDevice(bobRoot) };
}

function talk(author: string, text = "hello"): ThreadEvent {
  return { id: randomId(), threadId: randomId(), author, authorSeq: 0, parents: [], lane: "talk", type: "talk.posted", body: { text }, createdAt: Date.now() };
}

test("canonical form sorts keys and rejects ambiguity", () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonicalize({ a: 1.5 }));
  assert.throws(() => canonicalize({ a: undefined }));
  assert.throws(() => canonicalize("\ud800"));
  assert.throws(() => parseCanonical(utf8('{"b":1,"a":2}')));
  assert.throws(() => parseCanonical(utf8('{"a":1,"a":2}')));
  assert.throws(() => parseCanonical(utf8('{"a": 1}')));
});

test("signatures are bound to their domain", () => {
  const k = generateSigningKey();
  const sig = sign(k, "a/v1", utf8("m"));
  assert.ok(verify(k.publicKey, "a/v1", utf8("m"), sig));
  assert.ok(!verify(k.publicKey, "b/v1", utf8("m"), sig));
  assert.ok(!verify(k.publicKey, "a/v1", utf8("n"), sig));
  assert.ok(!verify("nonsense", "a/v1", utf8("m"), sig));
});

test("credential verifies, and rejects tampering, expiry and a foreign root", async () => {
  const { aliceRoot, alice, bobRoot } = await pair();
  assert.equal(verifyCredential(alice.credential).rootKey, aliceRoot.publicKey);
  assert.throws(() => verifyCredential({ ...alice.credential, expiresAt: alice.credential.expiresAt + 1 }), /signature/);
  assert.throws(() => verifyCredential({ ...alice.credential, rootKey: bobRoot.publicKey }), /signature/);
  assert.throws(() => verifyCredential(alice.credential, alice.credential.expiresAt), /expired/);
  assert.throws(() => verifyCredential({ ...alice.credential, extra: 1 }), /shape/);
});

test("seal then open round trips", async () => {
  const { alice, bob } = await pair();
  const event = talk(deviceId(alice.credential));
  const wire = await seal(event, alice, bob.credential, Date.now() + HOUR);
  const opened = await open(JSON.parse(JSON.stringify(wire)), bob);
  assert.deepEqual(opened.event, event);
  assert.equal(opened.credential.rootKey, alice.credential.rootKey);
});

test("the relay-visible header carries no sender and no content", async () => {
  const { alice, bob } = await pair();
  const wire = await seal(talk(deviceId(alice.credential), "secret-text"), alice, bob.credential, Date.now() + HOUR);
  const visible = JSON.stringify(wire);
  assert.ok(!visible.includes("secret-text"));
  assert.ok(!visible.includes(alice.credential.rootKey));
  assert.ok(!visible.includes(deviceId(alice.credential)));
});

test("open rejects tampered, misaddressed, expired and re-targeted messages", async () => {
  const { alice, bob } = await pair();
  const carol = await issueDevice(generateSigningKey());
  const event = talk(deviceId(alice.credential));
  const wire = await seal(event, alice, bob.credential, Date.now() + HOUR);

  const flipped = unb64u(wire.ct);
  flipped[5]! ^= 1;
  await assert.rejects(open({ ...wire, ct: b64u(flipped) }, bob), /decryption/);
  await assert.rejects(open({ ...wire, header: { ...wire.header, expiresAt: wire.header.expiresAt + 1 } }, bob), /decryption/);
  await assert.rejects(open({ ...wire, header: { ...wire.header, id: randomId() } }, bob), /decryption/);
  await assert.rejects(open(wire, carol), /not addressed/);
  await assert.rejects(open(wire, bob, wire.header.expiresAt + 1), /expired/);
  await assert.rejects(open({ ...wire, junk: 1 }, bob), /shape/);
});

test("a recipient cannot forward a signed event to someone else", async () => {
  const { alice, bob } = await pair();
  const carol = await issueDevice(generateSigningKey());
  const wire = await seal(talk(deviceId(alice.credential), "pay the bearer 100"), alice, bob.credential, Date.now() + HOUR);
  // Bob decrypts Alice's message and re-encrypts the signed plaintext to Carol.
  const info = utf8("counterpart/envelope/v1").buffer as ArrayBuffer;
  const plaintext = await hpke.open(
    { recipientKey: await hpke.kem.deserializePrivateKey(unb64u(bob.enc.secretKey).buffer as ArrayBuffer), enc: unb64u(wire.enc).buffer as ArrayBuffer, info },
    unb64u(wire.ct).buffer as ArrayBuffer,
    canonicalBytes(wire.header).buffer as ArrayBuffer,
  );
  const header = { ...wire.header, to: deviceId(carol.credential) };
  const { enc, ct } = await hpke.seal(
    { recipientPublicKey: await hpke.kem.deserializePublicKey(unb64u(carol.credential.encKey).buffer as ArrayBuffer), info },
    plaintext,
    canonicalBytes(header).buffer as ArrayBuffer,
  );
  await assert.rejects(open({ header, enc: b64u(enc), ct: b64u(ct) }, carol), /bad signature/);
});

test("a device cannot sign as another author", async () => {
  const { alice, bob } = await pair();
  await assert.rejects(seal(talk(deviceId(bob.credential)), alice, bob.credential, Date.now() + HOUR), /author/);
});

test("events are validated strictly", () => {
  const e = talk("d_" + "A".repeat(22));
  assert.ok(parseEvent(e));
  assert.throws(() => parseEvent({ ...e, type: "exec.run" }), /unknown type/);
  assert.throws(() => parseEvent({ ...e, lane: "control" }), /lane/);
  assert.throws(() => parseEvent({ ...e, body: { text: "x", path: "/etc/passwd" } }), /body/);
  assert.throws(() => parseEvent({ ...e, body: { text: "" } }), /body/);
  assert.throws(() => parseEvent({ ...e, type: "constructor" }), /unknown type/);
  assert.throws(() => parseEvent({ ...e, extra: true }), /shape/);
});

test("invites round trip and reject bad relays and expiry", async () => {
  const { alice } = await pair();
  const invite = { v: 1 as const, relay: "ws://127.0.0.1:1", credential: alice.credential, token: randomId(), expiresAt: Date.now() + HOUR };
  assert.deepEqual(decodeInvite(encodeInvite(invite)), invite);
  assert.throws(() => decodeInvite(encodeInvite({ ...invite, relay: "http://x" })), /ws/);
  assert.throws(() => decodeInvite(encodeInvite(invite), invite.expiresAt + 1), /expired/);
  assert.throws(() => decodeInvite("hello"), /not an invite/);
});

test("safety code is symmetric and differs per pair", async () => {
  const { aliceRoot, bobRoot } = await pair();
  const other = generateSigningKey();
  assert.equal(safetyCode(aliceRoot.publicKey, bobRoot.publicKey), safetyCode(bobRoot.publicKey, aliceRoot.publicKey));
  assert.notEqual(safetyCode(aliceRoot.publicKey, bobRoot.publicKey), safetyCode(aliceRoot.publicKey, other.publicKey));
  assert.match(safetyCode(aliceRoot.publicKey, bobRoot.publicKey), /^\d{4} \d{4} \d{4}$/);
});
