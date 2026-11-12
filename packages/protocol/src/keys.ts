import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { b64u, concat, unb64u, utf8 } from "./bytes.ts";

export const SUITE = "hpke-x25519-hkdfsha256-chacha20poly1305+ed25519/v1";

export const hpke = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

export interface KeyPair {
  publicKey: string; // base64url raw 32 bytes
  secretKey: string; // base64url raw 32 bytes
}

export function generateSigningKey(): KeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: jwk.x!, secretKey: jwk.d! };
}

export async function generateEncryptionKey(): Promise<KeyPair> {
  const kp = await hpke.kem.generateKeyPair();
  return {
    publicKey: b64u(await hpke.kem.serializePublicKey(kp.publicKey)),
    secretKey: b64u(await hpke.kem.serializePrivateKey(kp.privateKey)),
  };
}

function checkKey(k: string): void {
  if (unb64u(k).length !== 32) throw new Error("key must be 32 bytes");
}

// Every signature is bound to a purpose so a signature made for one message
// type can never be replayed as another.
function signingInput(domain: string, message: Uint8Array): Uint8Array {
  return concat(utf8(`counterpart/${domain}\n`), message);
}

export function sign(key: KeyPair, domain: string, message: Uint8Array): string {
  const priv = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: key.publicKey, d: key.secretKey } });
  return b64u(edSign(null, signingInput(domain, message), priv));
}

export function verify(publicKey: string, domain: string, message: Uint8Array, signature: string): boolean {
  try {
    checkKey(publicKey);
    const sig = unb64u(signature);
    if (sig.length !== 64) return false;
    const pub = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: publicKey } });
    return edVerify(null, signingInput(domain, message), pub, sig);
  } catch {
    return false;
  }
}
