// CPace over ristretto255 with SHA-512, as specified in draft-irtf-cfrg-cpace-21
// (sections 6, 7, 8.1, 8.3 and 10.4). Every function here is checked byte for
// byte against the draft's test vectors in packages/protocol/test/pake.test.ts.
//
// The group arithmetic, the ristretto255 encoding and the element derivation
// (RFC 9496) come from @noble/curves, which has had outside audits. Nothing
// here does arithmetic of its own.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { concat, utf8 } from "./bytes.ts";

const Point = ristretto255.Point;
type P = InstanceType<typeof Point>;

export const CPACE_DSI = utf8("CPaceRistretto255");
const DSI_ISK = utf8("CPaceRistretto255_ISK");
const S_IN_BYTES = 128; // SHA-512 input block size
const FIELD_BYTES = 32;
const GROUP_BITS = 252;
// G.I: the encoding of the neutral element.
export const IDENTITY = new Uint8Array(32);

const sha512 = (m: Uint8Array): Uint8Array => new Uint8Array(createHash("sha512").update(m).digest());

// LEB128 length, then the bytes (A.1.1).
export function prependLen(data: Uint8Array): Uint8Array {
  const len: number[] = [];
  let n = data.length;
  for (;;) {
    if (n < 128) len.push(n);
    else len.push((n & 0x7f) + 0x80);
    n = Math.floor(n / 128);
    if (n === 0) break;
  }
  return concat(new Uint8Array(len), data);
}

export const lvCat = (...parts: Uint8Array[]): Uint8Array => concat(...parts.map(prependLen));

// A.3.1
export function lexiographicallyLarger(a: Uint8Array, b: Uint8Array): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return a.length > b.length;
}

export const oCat = (a: Uint8Array, b: Uint8Array): Uint8Array => (lexiographicallyLarger(a, b) ? concat(utf8("oc"), a, b) : concat(utf8("oc"), b, a));

export const transcriptIr = (ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array => concat(lvCat(ya, ada), lvCat(yb, adb));
export const transcriptOc = (ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array => oCat(lvCat(ya, ada), lvCat(yb, adb));

// A.2
export function generatorString(dsi: Uint8Array, prs: Uint8Array, ci: Uint8Array, sid: Uint8Array, sInBytes = S_IN_BYTES): Uint8Array {
  const zpad = Math.max(0, sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length);
  return lvCat(dsi, prs, new Uint8Array(zpad), ci, sid);
}

// 8.3: hash the generator string to 64 bytes, then the RFC 9496 element derivation.
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): P {
  const hash = sha512(generatorString(CPACE_DSI, prs, ci, sid)).slice(0, 2 * FIELD_BYTES);
  return ristretto255_hasher.deriveToCurve!(hash);
}

// Scalars are 32 bytes, little endian.
const scalarOf = (y: Uint8Array): bigint => {
  if (y.length !== 32) throw new Error("pake: scalar must be 32 bytes");
  return BigInt(`0x${Buffer.from(y).reverse().toString("hex")}`) % Point.Fn.ORDER;
};

// 8.3: 32 random bytes with the bits above 252 cleared. A zero scalar (one
// chance in 2^252) is drawn again, because it would make the share the identity.
export function sampleScalar(): Uint8Array {
  for (;;) {
    const y = new Uint8Array(randomBytes(32));
    y[31]! &= (1 << (GROUP_BITS - 248)) - 1;
    if (scalarOf(y) !== 0n) return y;
  }
}

// y * g, encoded.
export const scalarMult = (y: Uint8Array, g: P): Uint8Array => g.multiply(scalarOf(y)).toBytes();

// 8.3: decode X; if that fails, or the result is the identity, return G.I.
export function scalarMultVfy(y: Uint8Array, x: Uint8Array): Uint8Array {
  let p: P;
  try {
    if (x.length !== 32) return IDENTITY;
    p = Point.fromBytes(x);
  } catch {
    return IDENTITY;
  }
  if (p.is0()) return IDENTITY;
  const s = scalarOf(y);
  if (s === 0n) return IDENTITY;
  // The constant-time multiply: y is secret, and its timing must not leak.
  const k = p.multiply(s);
  return k.is0() ? IDENTITY : k.toBytes();
}

export const isIdentity = (k: Uint8Array): boolean => k.length === IDENTITY.length && timingSafeEqual(k, IDENTITY);

// 7.2: ISK = H(lv_cat(DSI || "_ISK", sid, K) || transcript).
export const iskIr = (sid: Uint8Array, k: Uint8Array, ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array =>
  sha512(concat(lvCat(DSI_ISK, sid, k), transcriptIr(ya, ada, yb, adb)));
export const iskOc = (sid: Uint8Array, k: Uint8Array, ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array =>
  sha512(concat(lvCat(DSI_ISK, sid, k), transcriptOc(ya, ada, yb, adb)));

// 10.6
export const sidOutputIr = (ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array => sha512(concat(utf8("CPaceSidOutput"), transcriptIr(ya, ada, yb, adb)));
export const sidOutputOc = (ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array => sha512(concat(utf8("CPaceSidOutput"), transcriptOc(ya, ada, yb, adb)));

// 10.4: key confirmation. mac_key = H("CPaceMac" || sid || ISK); each side
// sends HMAC(mac_key, lv_cat(its share, its associated data)).
export const macKey = (sid: Uint8Array, isk: Uint8Array): Uint8Array => sha512(concat(utf8("CPaceMac"), sid, isk));
export const confirmTag = (key: Uint8Array, y: Uint8Array, ad: Uint8Array): Uint8Array => new Uint8Array(createHmac("sha512", key).update(lvCat(y, ad)).digest());
export const tagsEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b);

// One side of an initiator-responder CPace run. `share` is what it sends.
export interface CpaceSide {
  scalar: Uint8Array;
  share: Uint8Array;
}

export function cpaceStart(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array, scalar = sampleScalar()): CpaceSide {
  return { scalar, share: scalarMult(scalar, calculateGenerator(prs, ci, sid)) };
}

// The shared ISK, or null when the other share is invalid (the run must abort).
// A share equal to our own is refused too: that is a message reflected back.
export function cpaceFinish(me: CpaceSide, role: "initiator" | "responder", sid: Uint8Array, ownAd: Uint8Array, theirShare: Uint8Array, theirAd: Uint8Array): Uint8Array | null {
  if (theirShare.length === me.share.length && timingSafeEqual(theirShare, me.share)) return null;
  const k = scalarMultVfy(me.scalar, theirShare);
  if (isIdentity(k)) return null;
  return role === "initiator" ? iskIr(sid, k, me.share, ownAd, theirShare, theirAd) : iskIr(sid, k, theirShare, theirAd, me.share, ownAd);
}
