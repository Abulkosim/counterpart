import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { type KeyPair, b64u, canonicalBytes, unb64u } from "@counterpart/protocol";

// The root key is the person. Locked under a passphrase, it can only be used
// by someone who knows the passphrase, typed into a short-lived command. A
// program running as the same user (an agent with a shell, say) can read this
// file but cannot sign with it. That holds only as long as the machine itself
// is honest: a keylogger or a replaced `cpart` binary defeats it.
export interface SealedRoot {
  kdf: "scrypt";
  logN: number;
  r: number;
  p: number;
  salt: string;
  nonce: string;
  ct: string;
}

const MIN_LOG_N = 14;
const MAX_LOG_N = 20;
export const DEFAULT_LOG_N = 17;

function derive(passphrase: string, s: Pick<SealedRoot, "logN" | "r" | "p" | "salt">): Buffer {
  if (!Number.isInteger(s.logN) || s.logN < MIN_LOG_N || s.logN > MAX_LOG_N || s.r !== 8 || s.p !== 1) throw new Error("root key file has unsupported parameters");
  const N = 2 ** s.logN;
  return scryptSync(passphrase.normalize("NFKC"), unb64u(s.salt), 32, { N, r: s.r, p: s.p, maxmem: 256 * N * s.r });
}

// The public key and the parameters are authenticated with the ciphertext, so
// the file cannot be edited to pair this secret with a different identity.
const aad = (publicKey: string, s: Pick<SealedRoot, "kdf" | "logN" | "r" | "p" | "salt">): Uint8Array =>
  canonicalBytes({ purpose: "counterpart/root-key/v1", publicKey, kdf: s.kdf, logN: s.logN, r: s.r, p: s.p, salt: s.salt });

export function sealRoot(root: KeyPair, passphrase: string, logN = DEFAULT_LOG_N): SealedRoot {
  if (passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
  const base = { kdf: "scrypt" as const, logN, r: 8, p: 1, salt: b64u(randomBytes(16)) };
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(passphrase, base), nonce);
  cipher.setAAD(aad(root.publicKey, base));
  const ct = Buffer.concat([cipher.update(unb64u(root.secretKey)), cipher.final(), cipher.getAuthTag()]);
  return { ...base, nonce: b64u(nonce), ct: b64u(ct) };
}

export function unsealRoot(publicKey: string, sealed: SealedRoot, passphrase: string): KeyPair {
  const raw = unb64u(sealed.ct);
  if (sealed.kdf !== "scrypt" || raw.length !== 32 + 16) throw new Error("root key file is damaged");
  const decipher = createDecipheriv("aes-256-gcm", derive(passphrase, sealed), unb64u(sealed.nonce));
  decipher.setAAD(aad(publicKey, sealed));
  decipher.setAuthTag(raw.subarray(32));
  try {
    const secret = Buffer.concat([decipher.update(raw.subarray(0, 32)), decipher.final()]);
    return { publicKey, secretKey: b64u(secret) };
  } catch {
    throw new Error("wrong passphrase");
  }
}
