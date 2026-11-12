import { b64u, concat, sha256, unb64u } from "./bytes.ts";
import { canonicalBytes } from "./canonical.ts";
import { type KeyPair, generateEncryptionKey, generateSigningKey, sign, verify } from "./keys.ts";
import { isInt, isKey, isObject, isStr } from "./check.ts";

// A human holds a root key. Each device holds its own signing and encryption
// keys, vouched for by a credential the root key signs. Contacts pin the root
// key; devices can be rotated or expire without re-pairing.
export interface DeviceCredential {
  v: 1;
  rootKey: string;
  signKey: string;
  encKey: string;
  issuedAt: number;
  expiresAt: number;
  sig: string;
}

export interface DeviceSecrets {
  credential: DeviceCredential;
  sign: KeyPair;
  enc: KeyPair;
}

const DOMAIN = "device-credential/v1";
export const DEFAULT_CREDENTIAL_TTL_MS = 90 * 24 * 3600 * 1000;

const id = (prefix: string, ...keys: string[]): string =>
  prefix + b64u(sha256(concat(...keys.map(unb64u))).slice(0, 16));

export const humanId = (rootKey: string): string => id("h_", rootKey);
export const deviceId = (c: Pick<DeviceCredential, "signKey" | "encKey">): string => id("d_", c.signKey, c.encKey);

export async function issueDevice(root: KeyPair, now = Date.now(), ttlMs = DEFAULT_CREDENTIAL_TTL_MS): Promise<DeviceSecrets> {
  const signKey = generateSigningKey();
  const enc = await generateEncryptionKey();
  const body = { v: 1 as const, rootKey: root.publicKey, signKey: signKey.publicKey, encKey: enc.publicKey, issuedAt: now, expiresAt: now + ttlMs };
  return { credential: { ...body, sig: sign(root, DOMAIN, canonicalBytes(body)) }, sign: signKey, enc };
}

// Same device keys, fresh expiry. The device id does not change.
export function renewDevice(root: KeyPair, d: DeviceSecrets, now = Date.now(), ttlMs = DEFAULT_CREDENTIAL_TTL_MS): DeviceSecrets {
  const body = { v: 1 as const, rootKey: root.publicKey, signKey: d.sign.publicKey, encKey: d.enc.publicKey, issuedAt: now, expiresAt: now + ttlMs };
  return { ...d, credential: { ...body, sig: sign(root, DOMAIN, canonicalBytes(body)) } };
}

export function parseCredential(x: unknown): DeviceCredential {
  if (!isObject(x) || Object.keys(x).length !== 7) throw new Error("credential: shape");
  const { v, rootKey, signKey, encKey, issuedAt, expiresAt, sig } = x;
  if (v !== 1 || !isKey(rootKey) || !isKey(signKey) || !isKey(encKey) || !isInt(issuedAt) || !isInt(expiresAt) || !isStr(sig, 86, 86))
    throw new Error("credential: fields");
  return { v, rootKey, signKey, encKey, issuedAt, expiresAt, sig };
}

export function verifyCredential(x: unknown, now = Date.now()): DeviceCredential {
  const c = parseCredential(x);
  const { sig, ...body } = c;
  if (!verify(c.rootKey, DOMAIN, canonicalBytes(body), sig)) throw new Error("credential: bad signature");
  if (c.issuedAt > now + 5 * 60_000) throw new Error("credential: issued in the future");
  if (c.expiresAt <= now) throw new Error("credential: expired");
  return c;
}

// Short code two humans compare out of band. Order independent.
export function safetyCode(rootA: string, rootB: string): string {
  const [a, b] = [rootA, rootB].sort() as [string, string];
  const h = sha256(concat(unb64u(a), unb64u(b)));
  const n = Buffer.from(h.slice(0, 8)).readBigUInt64BE();
  return (n % 10n ** 12n).toString().padStart(12, "0").replace(/(\d{4})(?=\d)/g, "$1 ");
}
