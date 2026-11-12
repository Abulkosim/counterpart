import { utf8 } from "./bytes.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// RFC 8785 (JCS) for the subset we allow: no floats, no unpaired surrogates.
// Signatures cover these bytes, so anything ambiguous is rejected, not normalised.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical: only safe integers allowed");
    return String(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error("canonical: malformed string");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("canonical: plain objects only");
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys
      .map((k) => {
        if (obj[k] === undefined) throw new Error(`canonical: undefined at ${k}`);
        return `${canonicalize(k)}:${canonicalize(obj[k])}`;
      })
      .join(",")}}`;
  }
  throw new Error(`canonical: unsupported ${typeof value}`);
}

export const canonicalBytes = (value: unknown): Uint8Array => utf8(canonicalize(value));

// Parse and require that the input was already canonical. Rejects duplicate keys,
// odd whitespace and alternative encodings in one check.
export function parseCanonical(bytes: Uint8Array): Json {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text) as Json;
  if (canonicalize(value) !== text) throw new Error("canonical: input is not canonical");
  return value;
}
