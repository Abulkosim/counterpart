import { createHash, randomBytes } from "node:crypto";

export const b64u = (b: Uint8Array | ArrayBuffer): string =>
  Buffer.from(b as Uint8Array).toString("base64url");

export function unb64u(s: string): Uint8Array {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const bytes = Buffer.from(s, "base64url");
  // One encoding per value: stray bits in the last character are refused.
  if (bytes.toString("base64url") !== s) throw new Error("bad base64url");
  return new Uint8Array(bytes);
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(b).digest());
// Ids are typed on command lines, so one never starts with "-".
export function randomId(bytes = 16): string {
  for (;;) {
    const id = b64u(randomBytes(bytes));
    if (!id.startsWith("-")) return id;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
