// CPace against the published test vectors of draft-irtf-cfrg-cpace-21,
// Appendix A (string functions) and B.3 (ristretto255 with SHA-512). Every
// expected value below is copied from the draft. They must match byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CPACE_DSI, IDENTITY, calculateGenerator, confirmTag, cpaceFinish, cpaceStart, generatorString, iskIr, iskOc, lexiographicallyLarger, lvCat, macKey, oCat,
  prependLen, sampleScalar, scalarMult, scalarMultVfy, sidOutputIr, sidOutputOc, transcriptIr, transcriptOc, utf8,
} from "../src/index.ts";
import { createHash } from "node:crypto";

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "hex"));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const range = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i);

test("A.1.2 prepend_len", () => {
  assert.equal(toHex(prependLen(utf8(""))), "00");
  assert.equal(toHex(prependLen(utf8("1234"))), "0431323334");
  assert.equal(toHex(prependLen(range(127))), `7f${toHex(range(127))}`);
  assert.equal(toHex(prependLen(range(128))), `8001${toHex(range(128))}`);
});

test("A.1.4 lv_cat", () => {
  assert.equal(toHex(lvCat(utf8("1234"), utf8("5"), utf8(""), utf8("678"))), "043132333401350003363738");
});

test("A.3.3 ordered concatenation", () => {
  const b = (...x: number[]): Uint8Array => Uint8Array.from(x);
  assert.equal(lexiographicallyLarger(b(0), b(0, 0)), false);
  assert.equal(lexiographicallyLarger(b(1), b(0, 0)), true);
  assert.equal(lexiographicallyLarger(b(0, 0), b(0)), true);
  assert.equal(lexiographicallyLarger(b(0, 0), b(1)), false);
  assert.equal(lexiographicallyLarger(b(0, 1), b(1)), false);
  assert.equal(lexiographicallyLarger(utf8("ABCD"), utf8("BCD")), false);
  assert.equal(toHex(oCat(utf8("ABCD"), utf8("BCD"))), "6f6342434441424344");
  assert.equal(toHex(oCat(utf8("BCD"), utf8("ABCDE"))), "6f634243444142434445");
});

test("A.3.5 and A.3.7 transcripts", () => {
  const [pa, pb] = [utf8("PartyA"), utf8("PartyB")];
  assert.equal(toHex(transcriptIr(utf8("123"), pa, utf8("234"), pb)), "03313233065061727479410332333406506172747942");
  assert.equal(toHex(transcriptIr(utf8("3456"), pa, utf8("2345"), pb)), "043334353606506172747941043233343506506172747942");
  assert.equal(toHex(transcriptOc(utf8("123"), pa, utf8("234"), pb)), "6f6303323334065061727479420331323306506172747941");
  assert.equal(toHex(transcriptOc(utf8("3456"), pa, utf8("2345"), pb)), "6f63043334353606506172747941043233343506506172747942");
});

// B.3
const V = {
  PRS: utf8("Password"),
  CI: hex("0b415f696e69746961746f720b425f726573706f6e646572"),
  sid: hex("7e4b4791d6a8ef019b936c79fb7f2c57"),
  genStr: hex(`11435061636552697374726574746f3235350850617373776f726464
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000000000000000000000000000
    00000000000000000000000000000000180b415f696e69746961746f
    720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f
    2c57`),
  hash: hex(`da6d3ddc8802fca9058755ffd3ebde08a9c2c74945901a258482a288
    b6663af06bf645c93cd1c51512307199c80e84908916d983b34af772
    05f90851a657ee27`),
  g: hex("222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56"),
  ADa: utf8("ADa"),
  ya: hex("da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08"),
  Ya: hex("d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157"),
  ADb: utf8("ADb"),
  yb: hex("d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d"),
  Yb: hex("3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258"),
  K: hex("80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f"),
  trIr: hex(`20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0e
    ec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa
    8232b5ebe63324e2d9e7433f725803414462`),
  iskIr: hex(`b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dc
    ae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c
    3fa2068af7900447`),
  trOc: hex(`6f6320d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f
    8d0eec482b915703414461203ea7e0b19560d7c0b0f5734f63b95528
    6dfa8232b5ebe63324e2d9e7433f725803414462`),
  iskOc: hex(`544199d71f62f8d9a1fee55727e24fe4a45844593c2b6013c4fa3969
    d0e5debb2244675c0b43397cbb68d342b01fc0f98fc961469a25134d
    e9f0f813c1a57476`),
  sidIr: hex(`bb1c449b35f0ea79a65c209f329a693d475e0ce2387bed9fe4b78f60
    b2a27c219813fb2cfe175ef40d2222d9261e66da7d78f7c55a303b1b
    8611dcdfab880c47`),
  sidOc: hex(`10d5941d4933497fe31b9188d690b84465e2a2d158332a7267284a07
    1a8d0876fc5c8c329dc735d59a9f8ef6623ee23924704a2f929dd631
    ca981227ee82fff2`),
};

test("B.3.1 generator: string, hash and encoded generator", () => {
  const s = generatorString(CPACE_DSI, V.PRS, V.CI, V.sid);
  assert.equal(s.length, 170);
  assert.equal(toHex(s), toHex(V.genStr));
  assert.equal(toHex(new Uint8Array(createHash("sha512").update(s).digest())), toHex(V.hash));
  assert.equal(toHex(calculateGenerator(V.PRS, V.CI, V.sid).toBytes()), toHex(V.g));
});

test("B.3.2 to B.3.4 shares and K", () => {
  const g = calculateGenerator(V.PRS, V.CI, V.sid);
  assert.equal(toHex(scalarMult(V.ya, g)), toHex(V.Ya));
  assert.equal(toHex(scalarMult(V.yb, g)), toHex(V.Yb));
  assert.equal(toHex(scalarMultVfy(V.ya, V.Yb)), toHex(V.K));
  assert.equal(toHex(scalarMultVfy(V.yb, V.Ya)), toHex(V.K));
});

test("B.3.5 and B.3.6 ISK, initiator-responder and parallel", () => {
  assert.equal(toHex(transcriptIr(V.Ya, V.ADa, V.Yb, V.ADb)), toHex(V.trIr));
  assert.equal(toHex(iskIr(V.sid, V.K, V.Ya, V.ADa, V.Yb, V.ADb)), toHex(V.iskIr));
  assert.equal(toHex(transcriptOc(V.Ya, V.ADa, V.Yb, V.ADb)), toHex(V.trOc));
  assert.equal(toHex(iskOc(V.sid, V.K, V.Ya, V.ADa, V.Yb, V.ADb)), toHex(V.iskOc));
});

test("B.3.7 session id output", () => {
  assert.equal(toHex(sidOutputIr(V.Ya, V.ADa, V.Yb, V.ADb)), toHex(V.sidIr));
  assert.equal(toHex(sidOutputOc(V.Ya, V.ADa, V.Yb, V.ADb)), toHex(V.sidOc));
});

test("B.3.10 scalar_mult with valid inputs", () => {
  const s = hex("7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05");
  const X = hex("2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c");
  assert.equal(toHex(scalarMultVfy(s, X)), "7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e");
});

test("B.3.11 invalid inputs give the identity, and the run aborts", () => {
  const s = hex("7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05");
  const bad1 = hex("2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c");
  assert.equal(toHex(scalarMultVfy(s, bad1)), toHex(IDENTITY));
  assert.equal(toHex(scalarMultVfy(s, IDENTITY)), toHex(IDENTITY));
  assert.equal(toHex(scalarMultVfy(s, new Uint8Array(31))), toHex(IDENTITY));
  const me = cpaceStart(V.PRS, V.CI, V.sid, V.ya);
  assert.equal(cpaceFinish(me, "initiator", V.sid, V.ADa, bad1, V.ADb), null);
  assert.equal(cpaceFinish(me, "initiator", V.sid, V.ADa, IDENTITY, V.ADb), null);
});

test("the two roles agree on the spec's ISK, and a reflected share is refused", () => {
  const a = cpaceStart(V.PRS, V.CI, V.sid, V.ya);
  const b = cpaceStart(V.PRS, V.CI, V.sid, V.yb);
  assert.equal(toHex(a.share), toHex(V.Ya));
  assert.equal(toHex(cpaceFinish(a, "initiator", V.sid, V.ADa, b.share, V.ADb)!), toHex(V.iskIr));
  assert.equal(toHex(cpaceFinish(b, "responder", V.sid, V.ADb, a.share, V.ADa)!), toHex(V.iskIr));
  assert.equal(cpaceFinish(a, "initiator", V.sid, V.ADa, a.share, V.ADa), null);
});

test("a different password gives a different key; fresh scalars are in range", () => {
  const a = cpaceStart(V.PRS, V.CI, V.sid);
  const b = cpaceStart(utf8("Passworc"), V.CI, V.sid);
  assert.notEqual(toHex(cpaceFinish(a, "initiator", V.sid, V.ADa, b.share, V.ADb)!), toHex(cpaceFinish(b, "responder", V.sid, V.ADb, a.share, V.ADa)!));
  for (let i = 0; i < 50; i++) assert.ok(sampleScalar()[31]! < 0x10);
});

test("key confirmation tags follow section 10.4 and differ by side", () => {
  const k = macKey(V.sid, V.iskIr);
  assert.equal(toHex(k), toHex(new Uint8Array(createHash("sha512").update(Buffer.concat([Buffer.from("CPaceMac"), V.sid, V.iskIr])).digest())));
  assert.notEqual(toHex(confirmTag(k, V.Ya, V.ADa)), toHex(confirmTag(k, V.Yb, V.ADb)));
  assert.equal(confirmTag(k, V.Ya, V.ADa).length, 64);
});
