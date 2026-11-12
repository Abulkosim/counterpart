import { b64u, unb64u, utf8 } from "./bytes.ts";
import { canonicalBytes, parseCanonical } from "./canonical.ts";
import { isId, isInt, isObject, isStr, onlyKeys } from "./check.ts";
import { hashOf } from "./contract.ts";
import { LIMITS, type ThreadEvent, parseEvent } from "./events.ts";
import { type DeviceCredential, type DeviceSecrets, deviceId, verifyCredential } from "./identity.ts";
import { SUITE, hpke, sign, verify } from "./keys.ts";

// What the relay sees: who the message is for, when it expires, and ciphertext.
export interface WireHeader {
  v: 1;
  suite: typeof SUITE;
  id: string;
  to: string; // recipient device id
  expiresAt: number;
}

export interface Wire {
  header: WireHeader;
  enc: string;
  ct: string;
}

export interface Opened {
  event: ThreadEvent;
  credential: DeviceCredential; // verified, but the caller decides whether its root key is trusted
}

const INFO = utf8("counterpart/envelope/v1");
const SIG_DOMAIN = "event/v1";

export function parseWire(x: unknown): Wire {
  if (!isObject(x) || !onlyKeys(x, ["header", "enc", "ct"])) throw new Error("wire: shape");
  const { header: h, enc, ct } = x;
  if (!isObject(h) || !onlyKeys(h, ["v", "suite", "id", "to", "expiresAt"])) throw new Error("wire: header shape");
  if (h.v !== 1 || h.suite !== SUITE) throw new Error("wire: unsupported version or suite");
  if (!isId(h.id) || !isStr(h.to, 24, 24) || !h.to.startsWith("d_") || !isInt(h.expiresAt)) throw new Error("wire: header fields");
  if (!isStr(enc, 43, 43) || !isStr(ct, 1, LIMITS.wireBytes * 2)) throw new Error("wire: payload");
  return { header: { v: 1, suite: SUITE, id: h.id, to: h.to, expiresAt: h.expiresAt }, enc, ct };
}

export async function seal(
  event: ThreadEvent,
  from: DeviceSecrets,
  to: Pick<DeviceCredential, "signKey" | "encKey">,
  expiresAt: number,
): Promise<Wire> {
  parseEvent(event);
  if (event.author !== deviceId(from.credential)) throw new Error("seal: author is not this device");
  const header: WireHeader = { v: 1, suite: SUITE, id: event.id, to: deviceId(to), expiresAt };
  // The signature covers the header, so a recipient cannot re-encrypt a signed
  // event to a third party and pass it off as addressed to them.
  // It also covers the credential, so the same device key vouched for by a
  // different root cannot reuse the signature.
  const sig = sign(from.sign, SIG_DOMAIN, canonicalBytes({ header, event, credential: hashOf(from.credential) }));
  const plaintext = canonicalBytes({ event, sig, credential: from.credential });
  const recipientPublicKey = await hpke.kem.deserializePublicKey(unb64u(to.encKey).buffer as ArrayBuffer);
  const { enc, ct } = await hpke.seal({ recipientPublicKey, info: INFO.buffer as ArrayBuffer }, plaintext.buffer as ArrayBuffer, canonicalBytes(header).buffer as ArrayBuffer);
  const wire = { header, enc: b64u(enc), ct: b64u(ct) };
  if (canonicalBytes(wire).length > LIMITS.wireBytes) throw new Error("seal: message too large");
  return wire;
}

export async function open(wireInput: unknown, me: DeviceSecrets, now = Date.now()): Promise<Opened> {
  const wire = parseWire(wireInput);
  const { header } = wire;
  if (header.to !== deviceId(me.credential)) throw new Error("open: not addressed to this device");
  if (header.expiresAt <= now) throw new Error("open: expired");
  const recipientKey = await hpke.kem.deserializePrivateKey(unb64u(me.enc.secretKey).buffer as ArrayBuffer);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await hpke.open({ recipientKey, enc: unb64u(wire.enc).buffer as ArrayBuffer, info: INFO.buffer as ArrayBuffer }, unb64u(wire.ct).buffer as ArrayBuffer, canonicalBytes(header).buffer as ArrayBuffer),
    );
  } catch {
    throw new Error("open: decryption failed");
  }
  const inner = parseCanonical(plaintext);
  if (!isObject(inner) || !onlyKeys(inner, ["event", "sig", "credential"]) || !isStr(inner.sig, 86, 86)) throw new Error("open: inner shape");
  const credential = verifyCredential(inner.credential, now);
  const event = parseEvent(inner.event);
  if (event.id !== header.id) throw new Error("open: header and event id differ");
  if (event.author !== deviceId(credential)) throw new Error("open: author does not match credential");
  if (!verify(credential.signKey, SIG_DOMAIN, canonicalBytes({ header, event, credential: hashOf(credential) }), inner.sig)) throw new Error("open: bad signature");
  return { event, credential };
}
