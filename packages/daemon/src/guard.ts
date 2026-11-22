// The outbound guard. Every body this machine is about to send passes `screen`
// before it is sealed and queued. A hit holds the message: it is stored here,
// not sent, and the sender learns only the category. The owner reads it with
// `cpart held` and sends it with `cpart release`, which needs their passphrase.
//
// The point is that a sender who was fooled (an agent that read a hostile
// message) cannot move a secret off the machine through Counterpart, even when
// it tries plain text, base64, hex, reversal or separators.
//
// Patterns come from gitleaks (https://github.com/gitleaks/gitleaks, MIT
// License, Copyright (c) 2019 Zachary Rice), vendored as data in
// guard-data/gitleaks-rules.json by scripts/guard-vendor-gitleaks.py. Its
// "gitleaks:allow" comment is deliberately not honoured: anyone who writes the
// message could add it.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, openSync, closeSync, readFileSync, readSync, readdirSync, realpathSync, statSync, fstatSync, constants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { constants as zlib, gunzipSync, inflateSync } from "node:zlib";
import { randomId, utf8, verify } from "@counterpart/protocol";

export type GuardCategory =
  | "private-key"
  | "cloud-credential"
  | "jwt"
  | "api-token"
  | "generic-secret"
  | "env-secret"
  | "dotenv-value"
  | "config-value"
  | "never-share-file"
  // The message holds more encoded text than the guard will decode, so part of it went unchecked.
  | "too-much-to-check"
  // A never-share file the owner registered cannot be read whole, so nothing is checked against it.
  | "never-share-unreadable";

export type Encoding = "plain" | "reversed" | "split" | "base64" | "hex" | "url" | "escaped" | "spelled";

export interface Finding {
  category: GuardCategory;
  rule: string; // a gitleaks rule id, "env:NAME", "dotenv:<file>:NAME", "never-share:<file>" or a guard rule
  field: string; // where in the body: "text", "goal", "contract.parts.0.content"
  how: string; // how it was written: plain, reversed, split, base64, hex, url, escaped, or a chain like "base64>reversed"
  start: number; // span in the field's text; the whole field when the encoded form could not be placed
  end: number;
}

export class HeldError extends Error {
  readonly heldId: string;
  readonly reasons: GuardCategory[];
  constructor(id: string, reasons: GuardCategory[]) {
    super(`held for your human, reason: ${reasons.join(", ")}. Nothing was sent. Your human can review it with: cpart held`);
    this.heldId = id;
    this.reasons = reasons;
  }
}

export const isHeld = (e: unknown): e is HeldError => e instanceof HeldError;

// ---- rules ----

interface RuleData {
  id: string;
  regex: string;
  flags: string;
  secretGroup?: number;
  entropy?: number;
  keywords?: string[];
  allowlists?: { regexes?: { source: string; flags: string }[]; stopwords?: string[]; target: "secret" | "match" | "line"; condition: "OR" | "AND" }[];
}
interface Allow {
  regexes: RegExp[];
  stopwords: string[];
  target: "secret" | "match" | "line";
  and: boolean;
}
interface Rule {
  id: string;
  re: RegExp;
  secretGroup: number;
  entropy: number;
  keywords: string[];
  allow: Allow[];
  category: GuardCategory;
}

const DATA = new URL("./guard-data/gitleaks-rules.json", import.meta.url);

function categoryOf(id: string): GuardCategory {
  if (/private-key|pkcs|ssh|putty|age-secret/.test(id)) return "private-key";
  if (/jwt/.test(id)) return "jwt";
  if (/^(aws|gcp|google|azure|alibaba|digitalocean|cloudflare|linode|scaleway|yandex|ibm|oci|heroku|fly|vercel|netlify|hashicorp|vault|doppler|kubernetes|openshift|droneci|octopus|infracost|pulumi|terraform|tailscale)/.test(id)) return "cloud-credential";
  if (/^generic|password|curl|url-credentials|assignment/.test(id)) return "generic-secret";
  return "api-token";
}

const toAllow = (a: NonNullable<RuleData["allowlists"]>[number]): Allow => ({
  regexes: (a.regexes ?? []).map((r) => new RegExp(r.source, r.flags)),
  stopwords: (a.stopwords ?? []).map((s) => s.toLowerCase()),
  target: a.target,
  and: a.condition === "AND",
});

// Placeholders and the stock passwords of local development databases, as a
// URL's password.
const STOCK_PASSWORD = /^(?:\*+|x+|\.+|password|passwd|pass|pwd|secret|changeme|example|postgres|root|admin|guest|test|dev|user|mysql|redis|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\[[^\]]*\]|\{\{.*\}\}|%[A-Za-z_]+%)$/i;

// Rules of our own, for what the vendored set leaves to file paths or misses.
const OWN: { id: string; re: RegExp; category: GuardCategory; group?: number; allow?: RegExp }[] = [
  // A key block with or without its end line or body.
  { id: "guard-private-key-header", re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g, category: "private-key" },
  // "openssh-key-v1" in base64: the body of an OpenSSH private key, header or not.
  { id: "guard-openssh-key-body", re: /b3BlbnNzaC1rZXktdjE/g, category: "private-key" },
  { id: "guard-putty-key", re: /PuTTY-User-Key-File-\d+:/g, category: "private-key" },
  // Azure storage and Service Bus connection strings.
  { id: "azure-connection-string", re: /\b(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/]{30,}={0,2})/g, category: "cloud-credential", group: 1 },
  // A password inside a URL. Placeholders and the stock passwords of local
  // development databases are left alone.
  {
    id: "url-credentials",
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"`<>]{1,64}:([^\s@/'"`<>]{3,128})@[a-z0-9.[\]-]+/gi,
    category: "generic-secret",
    group: 1,
    allow: STOCK_PASSWORD,
  },
];

let RULES: { rules: Rule[]; global: Allow } | undefined;
function rules(): { rules: Rule[]; global: Allow } {
  if (RULES) return RULES;
  const data = JSON.parse(readFileSync(DATA, "utf8")) as { rules: RuleData[]; allowlist: { regexes: { source: string; flags: string }[]; stopwords: string[] } };
  const list: Rule[] = data.rules.map((r) => ({
    id: r.id,
    re: new RegExp(r.regex, `${r.flags}g`),
    secretGroup: r.secretGroup ?? 0,
    entropy: r.entropy ?? 0,
    keywords: r.keywords ?? [],
    allow: (r.allowlists ?? []).map(toAllow),
    category: categoryOf(r.id),
  }));
  RULES = {
    rules: list,
    global: { regexes: data.allowlist.regexes.map((r) => new RegExp(r.source, r.flags)), stopwords: data.allowlist.stopwords.map((s) => s.toLowerCase()), target: "secret", and: false },
  };
  return RULES;
}

function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const k of counts.values()) {
    const p = k / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function allowed(a: Allow, secret: string, match: string, line: string): boolean {
  const target = a.target === "match" ? match : a.target === "line" ? line : secret;
  const byRegex = a.regexes.length > 0 && target !== "" && a.regexes.some((r) => r.test(target));
  const lower = secret.toLowerCase();
  const byWord = a.stopwords.length > 0 && secret !== "" && a.stopwords.some((w) => lower.includes(w));
  if (!a.and) return byRegex || byWord;
  const checks = [...(a.regexes.length ? [byRegex] : []), ...(a.stopwords.length ? [byWord] : [])];
  return checks.length > 0 && checks.every(Boolean);
}

// An obvious stand-in for a value: an ellipsis, a template, "your-key-here",
// "REPLACE_ME", "changeme", "TODO".
const STAND_IN_WORDS = /\.\.\.|…|\{\{|your[_-]|[_-]here$|example|placeholder|change[_-]?(?:me|this)|replace[_-]?(?:me|this)|fill[_-]?(?:me|in)|set[_-]?me|insert[_-]|(?:^|[_.\s-])(?:todo|fixme|tbd|xxx+)(?:$|[_.\s-])|dummy|redacted|x{6,}|\*{3,}/i;
// What the generic rule finds that is plainly not a value: a stand-in, a
// variable name followed by "=", "$VAR", "<anything>".
const PLACEHOLDER = new RegExp(`^[A-Z][A-Z0-9_]*=|^\\$\\{?[A-Za-z_]|<[^>]*>|${STAND_IN_WORDS.source}`, "i");
// A value in a .env file or a URL's password that is a stand-in. Stricter
// than PLACEHOLDER: a real password can start with "$" ("$ecr3t...", literal
// in dotenv) or have "<" and ">" in it, and base32 ends in "=". So only
// "${...}", a whole "$UPPER_NAME", and "<words>" count as stand-ins here.
const standIn = (v: string): boolean => STAND_IN_WORDS.test(v) || /\$\{[A-Za-z_]|^\$[A-Z_][A-Z0-9_]*$|<[A-Za-z][A-Za-z _-]*>/.test(v);
// A hex string on a line that talks about digests is a digest.
const DIGEST_WORDS = /sha-?\d|md5|hash|digest|checksum|commit|etag|integrity|fingerprint/i;
// A UUID named as an idempotency key or a request id is an id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_WORDS = /idempotency|request[_-]?id|correlation|trace|span[_-]?id/i;

const lineAt = (text: string, at: number, end: number): string => {
  const s = text.lastIndexOf("\n", at - 1) + 1;
  const e = text.indexOf("\n", end);
  return text.slice(s, e < 0 ? text.length : e);
};

interface Hit {
  rule: string;
  category: GuardCategory;
  start: number;
  end: number;
}

const CHUNK = 4_000;
const OVERLAP = 1_000;

// Pattern hits in one piece of text, with gitleaks' own rules for which part
// of a match is the secret, entropy and allowlists.
// `shape` is for text put through rot13: then only rules for fixed token
// shapes apply. Ordinary text comes out with its placeholders scrambled and
// its structure intact, which the loose rules would take for a secret.
function patternHits(text: string, shape = false): Hit[] {
  // A few upstream patterns take time that grows with the square of a line's
  // length. Long text is checked in overlapping pieces.
  if (text.length > CHUNK + OVERLAP) {
    const out: Hit[] = [];
    const seen = new Set<string>();
    for (let at = 0; at < text.length; at += CHUNK) {
      for (const h of patternHits(text.slice(at, at + CHUNK + OVERLAP), shape)) {
        const k = `${h.rule} ${h.start + at}`;
        if (!seen.has(k)) out.push({ ...h, start: h.start + at, end: h.end + at });
        seen.add(k);
      }
    }
    return out;
  }
  const { rules: list, global } = rules();
  const lower = text.toLowerCase();
  const out: Hit[] = [];
  for (const r of list) {
    if (shape && r.category === "generic-secret") continue;
    if (r.keywords.length && !r.keywords.some((k) => lower.includes(k))) continue;
    for (const m of text.matchAll(r.re)) {
      const match = m[0];
      if (!match) continue;
      let secret = match;
      if (m.length >= 2) secret = r.secretGroup > 0 ? (m[r.secretGroup] ?? "") : (m.slice(1).find((g) => g) ?? match);
      if (!secret) continue;
      if (r.entropy && entropy(secret) <= r.entropy) continue;
      const line = lineAt(text, m.index, m.index + match.length);
      if (allowed(global, secret, match, line)) continue;
      if (r.allow.some((a) => allowed(a, secret, match, line))) continue;
      if (r.id.startsWith("generic") && (PLACEHOLDER.test(secret) || (/^[0-9a-f]+$/i.test(secret) && DIGEST_WORDS.test(line)) || (UUID.test(secret) && ID_WORDS.test(match)))) continue;
      out.push({ rule: r.id, category: r.category, start: m.index, end: m.index + match.length });
    }
  }
  for (const r of OWN) {
    if (shape && r.category === "generic-secret") continue;
    r.re.lastIndex = 0;
    for (const m of text.matchAll(r.re)) {
      const secret = r.group ? (m[r.group] ?? "") : m[0];
      if (r.allow?.test(secret) || (r.id === "url-credentials" && PLACEHOLDER.test(secret))) continue;
      // A URL whose password is its user name is a local default, not a secret.
      if (r.id === "url-credentials" && new RegExp(`//${escapeRe(secret)}:`).test(m[0])) continue;
      out.push({ rule: r.id, category: r.category, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

// ---- encodings ----

interface View {
  text: string;
  how: string;
  span: [number, number] | null; // where in the field this came from, if known
}

export interface Views {
  list: View[];
  incomplete: boolean; // a limit was reached and something went undecoded
}

const MIN_VIEWS = 2000; // and one more for every 2 characters of the field
const MIN_DECODED = 512 * 1024;
const MAX_CODES = 65_536;
const MAX_DEPTH = 4; // encodings inside encodings

// The readable stretches of decoded bytes. Random bytes (hashes, compressed
// data) give none of any length; text that was encoded comes back whole, even
// when the encoded run was cut at the wrong place or had words glued to it.
const UNREADABLE = /[�\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/;
function readable(s: string): string[] {
  const parts = s.split(UNREADABLE).filter((x) => x.length >= 6);
  // UTF-16 text, as in PowerShell's -EncodedCommand, has a NUL after every
  // ASCII character. Read it without them too.
  const nuls = s.length - s.replaceAll("\u0000", "").length;
  if (nuls >= 6 && nuls * 3 >= s.length) parts.push(...readable(s.replaceAll("\u0000", "")));
  return parts;
}

const MAX_INFLATE = 1024 * 1024;
class TooBig extends Error {}
// What may still be inflated in the field being read; views() sets it. All
// compressed runs in one field together get MAX_INFLATE.
let inflateLeft = MAX_INFLATE;

// Decoded bytes as text. Compressed bytes (gzip or zlib) are inflated too,
// and what comes out follows a NUL, which `readable` splits on. Output past
// the bound throws TooBig: the caller holds rather than send it unread.
function bytesText(b: Buffer): string {
  const plain = b.toString("utf8");
  if (b.length < 10) return plain;
  const gzip = b[0] === 0x1f && b[1] === 0x8b;
  const deflate = b[0] === 0x78 && (b[0] * 256 + b[1]!) % 31 === 0;
  if (!gzip && !deflate) return plain;
  try {
    // A cut-off stream still gives what it has.
    const opts = { maxOutputLength: Math.max(1, inflateLeft), finishFlush: zlib.Z_SYNC_FLUSH };
    const out = gzip ? gunzipSync(b, opts) : inflateSync(b, opts);
    inflateLeft -= out.length;
    return `${plain}\u0000${out.toString("utf8")}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) throw new TooBig();
    return plain; // not compressed after all
  }
}

const codePoint = (n: number): string => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\u0000");

const reverse = (s: string): string => [...s].reverse().join("");

function fromCodes(codes: number[]): string {
  let out = "";
  for (let i = 0; i < codes.length; i += 4096) out += String.fromCharCode(...codes.slice(i, i + 4096));
  return out;
}

function base32(s: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, "")) {
    value = ((value << 5) | A.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out).toString("utf8");
}

const rot13 = (s: string): string => s.replace(/[A-Za-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - (c <= "Z" ? 65 : 97) + 13) % 26) + (c <= "Z" ? 65 : 97)));

// Spelled out, as on the phone: "Alfa Kilo India, three", "k as in Kilo",
// a numbered list with one character a line. Known words become their
// character, single characters stay, anything else breaks the run.
const SPOKEN: Record<string, string> = {
  alpha: "a", alfa: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f", golf: "g", hotel: "h", india: "i", juliet: "j", juliett: "j",
  kilo: "k", lima: "l", mike: "m", november: "n", oscar: "o", papa: "p", quebec: "q", romeo: "r", sierra: "s", tango: "t", uniform: "u", victor: "v",
  whiskey: "w", whisky: "w", xray: "x", yankee: "y", zulu: "z",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", niner: "9",
};
const SPOKEN_FILLER = new Set(["underscore", "dash", "hyphen", "slash", "plus", "capital", "uppercase", "lowercase", "upper", "lower", "letter", "digit", "number", "then", "as", "in", "for", "like", "the"]);
const SPOKEN_MIN = 6; // spelled words in a text before it is read this way
function spoken(s: string): string | null {
  const words = s
    .toLowerCase()
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")
    .replace(/x[\s-]ray/g, "xray")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !SPOKEN_FILLER.has(w));
  if (words.filter((w) => SPOKEN[w]).length < SPOKEN_MIN) return null;
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const c = SPOKEN[w] ?? (w.length === 1 ? w : " ");
    // A character said twice, plain and as its word ("k Kilo"), is one character.
    const next = words[i + 1];
    if (c !== " " && next && (w.length === 1) !== (next.length === 1) && (SPOKEN[next] ?? (next.length === 1 ? next : "")) === c) i++;
    out.push(c);
  }
  return out.join("");
}

const unescape = (s: string): string =>
  s.replace(/\\u([0-9a-fA-F]{4})|\\([nrt"\\/])/g, (_, h: string | undefined, c: string | undefined) => (h ? String.fromCharCode(parseInt(h, 16)) : c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c!));
// Pieces put on separate lines, between quotes, or joined with + in code.
const unsplit = (s: string): string => s.replace(/["'`]\s*\+\s*["'`]/g, "").replace(/["'`\s,;|]+/g, "");

// Every encoded run in a text, decoded: [kind, decoded, index, length].
// Throws TooBig when compressed data inflates past the bound.
function decodings(text: string): [string, string, number, number][] {
  const out: [string, string, number, number][] = [];
  // Hex, with or without separators, 0x or \x prefixes (the backslash doubled in JSON).
  for (const m of text.matchAll(/(?:(?:\\{1,2}x|0x)?[0-9a-fA-F]{2}[\s:,-]?){8,}/g)) {
    const hex = m[0].replace(/\\{1,2}x|0x|[\s:,-]/g, "");
    if (hex.length % 2 === 0) out.push(["hex", bytesText(Buffer.from(hex, "hex")), m.index, m[0].length]);
  }
  // Base64 in either alphabet, tried at each alignment in case it was cut out of a longer run.
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) {
    const s = m[0];
    if (/^[0-9a-fA-F]+$/.test(s)) continue;
    for (let skip = 0; skip < 4 && s.length - skip >= 8; skip++) out.push(["base64", bytesText(Buffer.from(s.slice(skip), "base64")), m.index, s.length]);
  }
  // Bytes in binary: "01011010 01110100 ...".
  for (const m of text.matchAll(/(?:\b[01]{8}\b[\s,;]*){6,}/g)) {
    out.push(["binary", bytesText(Buffer.from(m[0].split(/[\s,;]+/).filter(Boolean).map((b) => parseInt(b, 2)))), m.index, m[0].length]);
  }
  // HTML character references, decimal or hex: "&#90;&#x74;".
  for (const m of text.matchAll(/(?:&#(?:[0-9]{1,7}|[xX][0-9a-fA-F]{1,6});?\s*){4,}/g)) {
    out.push(["entities", m[0].replace(/&#(?:([0-9]+)|[xX]([0-9a-fA-F]+));?\s*/g, (_, d: string | undefined, h: string | undefined) => codePoint(d ? Number(d) : parseInt(h!, 16))), m.index, m[0].length]);
  }
  // Octal escapes: "\132\164" (the backslash doubled in JSON).
  for (const m of text.matchAll(/(?:\\{1,2}[0-7]{1,3}){4,}/g)) {
    out.push(["octal", m[0].replace(/\\{1,2}([0-7]{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))), m.index, m[0].length]);
  }
  // Percent-encoding.
  for (const m of text.matchAll(/(?:%[0-9a-fA-F]{2}|[A-Za-z0-9._~+-]){6,}/g)) {
    if ((m[0].match(/%/g)?.length ?? 0) < 3) continue;
    try {
      out.push(["url", decodeURIComponent(m[0].replace(/\+/g, " ")), m.index, m[0].length]);
    } catch {
      // not valid percent-encoding
    }
  }
  // Base32, as in TOTP secrets and some exports.
  for (const m of text.matchAll(/\b[A-Z2-7]{16,}=*/g)) out.push(["base32", base32(m[0]), m.index, m[0].length]);
  // Character codes in decimal: "90, 116, 52, ...".
  for (const m of text.matchAll(/(?:\b(?:3[2-9]|[4-9]\d|1[01]\d|12[0-6])\b[\s,;]*){8,}/g)) {
    out.push(["codes", fromCodes(m[0].split(/[\s,;]+/).filter(Boolean).slice(0, MAX_CODES).map(Number)), m.index, m[0].length]);
  }
  // \u escapes.
  for (const m of text.matchAll(/(?:\\u[0-9a-fA-F]{4}){4,}/g)) {
    out.push(["escaped", m[0].replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), m.index, m[0].length]);
  }
  return out;
}

// The field as written and every way of reading it the guard knows: turned
// around, rot13, full-width folded, unescaped, with separators taken out, and
// each encoded run decoded, two levels deep, with the same done to what comes
// out. Work is bounded; when a bound is reached the result says so, and the
// message is held rather than sent half-checked.
export function views(text: string): Views {
  const list: View[] = [];
  const seen = new Set<string>();
  let bytes = Math.max(MIN_DECODED, 12 * text.length);
  inflateLeft = MAX_INFLATE;
  const maxViews = Math.max(MIN_VIEWS, Math.ceil(text.length / 2));
  let incomplete = false;
  const queue: { v: View; depth: number; surface: number }[] = [];
  const add = (t: string, how: string, span: View["span"], depth: number, surface: number): void => {
    if (!t || seen.has(t)) return;
    if (list.length >= maxViews || bytes < t.length) {
      incomplete = true;
      return;
    }
    bytes -= t.length;
    seen.add(t);
    const v = { text: t, how, span };
    list.push(v);
    queue.push({ v, depth, surface });
  };
  const chain = (how: string, step: string): string => (how === "plain" ? step : `${how}>${step}`);
  add(text, "plain", null, 0, 0);
  for (let i = 0; i < queue.length; i++) {
    const { v, depth, surface } = queue[i]!;
    // Surface changes, on every reading, up to three in a row. These undo
    // themselves (reversing twice, rot13 twice) or settle (joining twice),
    // so three covers the combinations that matter.
    // Random bytes decode to many short readable scraps; those are not worth turning around.
    if (surface < 3 && (depth === 0 || v.text.length >= 8)) {
      add(reverse(v.text), chain(v.how, "reversed"), v.span, depth, surface + 1);
      add(unsplit(v.text), chain(v.how, "split"), v.span, depth, surface + 1);
      add(rot13(v.text), chain(v.how, "rot13"), v.span, depth, surface + 1);
      add(v.text.normalize("NFKC"), chain(v.how, "folded"), v.span, depth, surface + 1);
      const sp = spoken(v.text);
      if (sp) add(sp, chain(v.how, "spelled"), v.span, depth, surface + 1);
      if (/\\[nrtu"\\/]/.test(v.text)) add(unescape(v.text), chain(v.how, "escaped"), v.span, depth, surface + 1);
    }
    let runs: ReturnType<typeof decodings>;
    try {
      runs = decodings(v.text);
    } catch (e) {
      if (!(e instanceof TooBig)) throw e;
      incomplete = true;
      continue;
    }
    for (const [kind, decoded, at, len] of runs) {
      const span: View["span"] = v.how === "plain" ? [at, at + len] : v.span;
      for (const part of readable(decoded)) {
        // Text that decodes to a piece of itself ("3333" as hex) adds nothing.
        if (v.text.includes(part)) continue;
        // Something still decodes at the last level: say so rather than stop quietly.
        if (depth >= MAX_DEPTH) {
          if (part.length >= 16 && !seen.has(part)) incomplete = true;
          continue;
        }
        add(part, chain(v.how, kind), span, depth + 1, 0);
      }
    }
  }
  return { list, incomplete };
}

const compact = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

// ---- exact values: the environment, .env files, never-share files ----

export interface Exact {
  value: string;
  compact: string;
  category: GuardCategory;
  rule: string;
  whole?: boolean; // only the whole value counts, not pieces of it (a URL: its host and path are not secret)
  fixed?: number; // letters and digits at the start that are the same in every key of its kind (sk_live_, AKIA); not counted in pieces
}

// The start of a key that is the same in every key of its kind: a vendor's
// prefix (sk_live_, ghp_, xoxb-, AKIA), or one or two short lowercase words
// ending in _ or - before a run of sixteen or more letters and digits
// (pt_, svc_, rk_test_). Anyone can know it, so a piece of a key is counted
// in what comes after it.
const KNOWN_PREFIX = /^(?:sk-ant-[a-z]{2,8}\d\d-|sk-(?:proj|svcacct|admin)-|github_pat_|glpat-|gldt-|xox[a-z]-|xapp-\d-|pypi-AgEIcHlwaS5vcmc|(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA|ASCA)(?=[A-Z0-9]{16}$)|AIza|ya29\.|dop_v1_|doo_v1_|shp(?:at|ss|ca|pa)_)/;
const LEADING = /^(?:[a-z]{1,8}[_-]){1,2}(?=[A-Za-z0-9]{16,}$)/;
export const fixedPrefix = (value: string): number => compact((KNOWN_PREFIX.exec(value) ?? LEADING.exec(value))?.[0] ?? "").length;

// Any name with KEY or PASS as a word of its own counts (OPENAI_KEY, HMAC_KEY,
// SMTP_PASS), as well as the names below.
const SECRET_NAME = /secret|token|passw|pwd|passphrase|(?:^|[_.-])(?:key|pass)(?:$|[_.-])|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth(?!or)|session|cookie|signing|salt|dsn|database[_-]?url|db[_-]?url|conn(?:ection)?[_-]?str|webhook|bearer|jwt|encryption[_-]?key|master[_-]?key|license[_-]?key/i;
const NOT_SECRET_NAME = /^(?:XDG_|DBUS_|SSH_AUTH_SOCK$|SSH_AGENT_PID$|GPG_|DESKTOP_SESSION$|SESSION_MANAGER$|TERM_SESSION_ID$|ITERM_SESSION_ID$|TMUX|KITTY_|WINDOWID$)|(?:_SOCK|_SOCKET|_PATH|_DIR|_FILE|_HOME|_PID|_HOST|_PORT|_USER|_USERNAME|_NAME|_EMAIL|_REGION|_ENDPOINT|_ID|_PREFIX|_SUFFIX|_FORMAT|_TYPE|_LENGTH|_SIZE|_TTL|_VERSION)$/i;
const DULL = /^(?:true|false|null|none|yes|no|on|off|localhost|development|production|staging|test|debug|info|warn|warning|error|enabled|disabled)$/i;

// Is this value worth holding a message over when it shows up exactly?
function worthMatching(value: string, secretName: boolean): boolean {
  if (value.length < 8 || value.length > 8192) return false;
  if (DULL.test(value)) return false;
  if (/^[0-9]+$/.test(value) && value.length < 12) return false;
  if (/^[A-Za-z]+$/.test(value) && value.length < 12) return false;
  if (/^(?:\/|~\/|\.\.?\/|[A-Za-z]:\\)\S*$/.test(value)) return false; // a path
  // A URL is a secret when it has a password in it that counts, a user name
  // that looks like a key, or when a secret-named variable holds it and a part
  // of it looks like a key.
  if (isUrl(value)) return urlPassword(value) !== null || tokenLike(urlLogin(value)?.user ?? "") || (secretName && urlKeys(value).length > 0);
  if (secretName) return true;
  return tokenLike(value);
}

const tokenLike = (v: string): boolean => v.length >= 16 && v.length <= 512 && !/\s/.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v) && entropy(v) >= 3.0;

const isUrl = (v: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(v);

// The user, password and host of a URL with a login in it.
function urlLogin(value: string): { user: string; password: string | null; host: string } | null {
  // The login runs to the "@": a password may hold "#" or "?" written raw.
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/\s@]*)@([^/?#\s]*)/i.exec(value);
  if (!m) return null;
  const at = m[1]!.indexOf(":");
  const host = m[2]!.toLowerCase().replace(/:\d*$/, "").replace(/^\[(.*)\]$/, "$1");
  return at < 0 ? { user: m[1]!, password: null, host } : { user: m[1]!.slice(0, at), password: m[1]!.slice(at + 1), host };
}

// A host on this machine or in a local compose network: localhost, a
// loopback address, or a name with no dot in it ("db", "postgres").
const localHost = (h: string): boolean => /^(?:localhost|[a-z0-9.-]*\.localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0|host\.docker\.internal|[a-z0-9_-]+)$/.test(h);

// A URL's password, when it counts as a secret: not a placeholder, and not a
// local default (the user name again, or a stock password, on a local host).
function urlPassword(value: string): string | null {
  const l = urlLogin(value);
  if (!l?.password) return null;
  const pw = l.password;
  if (standIn(pw)) return null;
  if (localHost(l.host) && (pw === l.user || STOCK_PASSWORD.test(pw))) return null;
  return pw;
}

// The parts of a URL that look like keys: a password, a path segment, a query value.
function urlKeys(value: string): string[] {
  const out: string[] = [];
  const pw = urlPassword(value);
  if (pw && pw.length >= 8) out.push(pw);
  const user = urlLogin(value)?.user;
  if (user && tokenLike(user)) out.push(user);
  const rest = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  for (const part of rest.split(/[/?&=#]+/)) {
    let plain = part;
    try {
      plain = decodeURIComponent(part);
    } catch {
      // not percent-encoded
    }
    for (const p of new Set([part, plain])) if (tokenLike(p)) out.push(p);
  }
  return out;
}

function exact(value: string, category: GuardCategory, rule: string): Exact[] {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  // A whole URL counts only whole: its host and path are not secret. The
  // parts that look like keys count on their own, pieces included.
  const one = (v: string): Exact => {
    const fixed = fixedPrefix(v);
    return { value: v, compact: compact(v), category, rule, ...(fixed ? { fixed } : {}) };
  };
  if (!url) return [one(value)];
  return [{ value, compact: compact(value), category, rule, whole: true }, ...urlKeys(value).map(one)];
}

export function envValues(env: Record<string, string | undefined>): Exact[] {
  const out: Exact[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || NOT_SECRET_NAME.test(name) || !SECRET_NAME.test(name)) continue;
    if (worthMatching(value, true)) out.push(...exact(value, "env-secret", `env:${name}`));
  }
  return out;
}

function parseDotenv(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/\s+#.*$/, "");
    if (v) out.push({ name: m[1]!, value: v });
  }
  return out;
}

const MAX_FILE = 4 * 1024 * 1024;

// Read a regular file without following a symlink at its last component.
// Null when it cannot be read whole.
function readSmall(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n === st.size ? buf.toString("utf8") : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".cache", ".turbo", "coverage"]);

export const WALK_DEPTH = 12;
const WALK_DIRS = 20_000;

// What the .env search could not reach. Filled in by dotenvFiles.
export interface WalkLimit {
  dirs: number; // directories left to read
  cut: Set<string>; // repositories where the search stopped early
}
export const walkLimit = (): WalkLimit => ({ dirs: WALK_DIRS, cut: new Set() });

// .env files anywhere in a repository, without following links. The search
// is bounded; where it stops early, the repository goes in `limit.cut`, so
// the gap is reported rather than passed over.
// With `configs`, the same walk also collects config files there (see configValues).
export function dotenvFiles(root: string, limit: WalkLimit = walkLimit(), configs?: string[]): string[] {
  const out: string[] = [];
  const inDataDir = (dir: string): boolean => relative(root, dir).split(sep).some((p) => NOT_CONFIG_DIR.test(p));
  const walk = (dir: string, depth: number): void => {
    if (depth > WALK_DEPTH || limit.dirs <= 0) {
      limit.cut.add(root);
      return;
    }
    limit.dirs--;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      // Dirent types come from lstat: a link is neither a directory nor a file here.
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(join(dir, d.name), depth + 1);
      } else if (d.isFile() && (/^\.env(?:\..+)?$/.test(d.name) || /.\.env$/.test(d.name))) out.push(join(dir, d.name));
      else if (configs && d.isFile() && CONFIG_FILE.test(d.name) && !NOT_CONFIG_FILE.test(d.name) && !inDataDir(dir)) configs.push(join(dir, d.name));
    }
  };
  walk(root, 0);
  return out;
}

// A template for a .env file: .env.example, .env.sample, .env.template,
// .env.dist, .env.defaults, app.example.env. It is committed and full of
// stand-ins, so its values must look like keys to count.
const TEMPLATE_ENV = /(?:^|\.)(?:example|sample|template|tmpl|tpl|dist|defaults?)(?:\.|$)/i;

export function dotenvValues(file: string): Exact[] {
  const text = readSmall(file);
  if (text === null) return [];
  const template = TEMPLATE_ENV.test(basename(file));
  const out: Exact[] = [];
  for (const { name, value } of parseDotenv(text)) {
    if (!isUrl(value) && standIn(value)) continue;
    const secretName = SECRET_NAME.test(name) && !NOT_SECRET_NAME.test(name);
    // In a template, the stricter test config values get; a URL only for a key-like password or user.
    const counts = !template ? worthMatching(value, secretName) : isUrl(value) ? configSecret(urlPassword(value) ?? "") || tokenLike(urlLogin(value)?.user ?? "") : configSecret(value);
    if (counts) out.push(...exact(value, "dotenv-value", `dotenv:${file}:${name}`));
  }
  return out;
}

// Config files: values under secret-named keys count like .env values. Only
// those, since config files hold many ordinary values. A token found only by
// its pattern is missed once it is reversed or sent in halves; one known
// exactly is not.
const CONFIG_FILE = /\.(?:ya?ml|toml|json|ini|cfg|conf|properties|xml)$|^(?:credentials|secrets?)(?:\..+)?$/i;
const MAX_CONFIG = 256 * 1024;
const MAX_CONFIG_VALUES = 200;

// A config value counts only when it looks like a key: one token, no spaces
// or template markers, ten or more characters, not words. Config and data
// files are full of sentences and settings under names like "auth".
const configSecret = (v: string): boolean =>
  worthMatching(v, true) && v.length >= 10 && !/[\s<>{}$]/.test(v) && !words(v) && entropy(v) >= 3;
// Letters joined by - _ or . in pieces short enough to be words: "orders-service".
const words = (v: string): boolean => /^[a-z]+(?:[-_.][a-z]+)*$/i.test(v) && v.split(/[-_.]/).every((p) => p.length <= 12);

// Directories whose files are data or tests, not the project's settings.
const NOT_CONFIG_DIR = /^(?:tests?|__tests__|spec|specs|fixtures?|testdata|test-data|__fixtures__|__mocks__|mocks?|e2e|examples?|samples?|results?|snapshots?|__snapshots__|docs?)$/i;
const NOT_CONFIG_FILE = /^(?:package(?:-lock)?\.json|tsconfig.*\.json|jsconfig\.json|composer\.lock|.*\.lock|pnpm-lock\.yaml|yarn\.lock|.*\.schema\.json|.*\.min\.json)$/i;

function configValues(file: string): Exact[] {
  const text = readSmall(file);
  if (text === null || text.length > MAX_CONFIG) return [];
  const out: Exact[] = [];
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (n >= MAX_CONFIG_VALUES) break;
    // key: value, key = value, "key": "value", <key>value</key>
    const m = /^\s*(?:-\s+)?["']?([A-Za-z_][\w.\-/:@]*?)["']?\s*[:=]\s*(.+?)\s*,?\s*$/.exec(raw) ?? /^\s*<([A-Za-z_][\w.-]*)>([^<]+)<\/\1>\s*$/.exec(raw);
    if (!m) continue;
    const name = m[1]!.split(/[.:/]/).pop()!;
    let v = m[2]!.trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/\s+#.*$/, "");
    if (!SECRET_NAME.test(name) || NOT_SECRET_NAME.test(name) || !configSecret(v)) continue;
    out.push(...exact(v, "config-value", `config:${file}:${name}`));
    n++;
  }
  return out;
}

// Credential files in the home directory the sending program sees. Their
// values are secret whatever they are called.
const HOME_FILES = [".aws/credentials", ".netrc", ".pgpass", ".git-credentials", ".npmrc", ".pypirc", ".docker/config.json"];

function homeValues(home: string | undefined): { files: string[]; exact: Exact[] } {
  if (!home) return { files: [], exact: [] };
  const files: string[] = [];
  const out: Exact[] = [];
  for (const rel of HOME_FILES) {
    const file = join(home, rel);
    const text = readSmall(file);
    if (text === null || text.length > MAX_CONFIG) continue;
    files.push(file);
    const rule = `home:~/${rel}`;
    const add = (v: string): void => {
      if (worthMatching(v, true)) out.push(...exact(v, "config-value", rule));
    };
    if (rel === ".netrc") for (const m of text.matchAll(/\bpassword\s+(\S+)/g)) add(m[1]!);
    else if (rel === ".pgpass") for (const line of text.split(/\r?\n/)) add(line.split(":").slice(4).join(":"));
    else if (rel === ".git-credentials") for (const m of text.matchAll(/:\/\/[^:/\s]*:([^@\s]+)@/g)) add(decodeURIComponent(m[1]!));
    else
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*["']?([^\s=:"'[]+)["']?\s*[=:]\s*["']?([^"'\s,]+)/.exec(line);
        if (m && SECRET_NAME.test(m[1]!)) add(m[2]!);
      }
  }
  return { files, exact: out };
}

// The repository a directory is in: the nearest parent with a .git entry.
export function repoRoot(dir: string): string | null {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// A never-share file. Any run of about 40 letters and digits from it is
// caught, however it is spaced or punctuated, and so is every token in it
// that looks like a key, alone.
const SHINGLE = 32;
const STEP = 8;
export interface Shingles {
  file: string;
  set: Set<string>;
}

// Why a registered file gives no protection right now, or null when it does.
function fileProblem(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "cannot be found";
  }
  if (st.isSymbolicLink()) return "is now a symbolic link";
  if (!st.isFile()) return "is not a file";
  if (st.size > MAX_FILE) return `is larger than ${MAX_FILE / 1024 / 1024} MB`;
  if (readSmall(path) === null) return "cannot be read";
  return null;
}

export function neverShare(file: string): { shingles: Shingles | null; exact: Exact[] } {
  const text = readSmall(file);
  if (text === null) return { shingles: null, exact: [] };
  const c = compact(text);
  const rule = `never-share:${file}`;
  const out: Exact[] = [];
  for (const tok of new Set(text.split(/[\s"'`=:,;()[\]{}<>]+/))) if (tokenLike(tok) || (tok.length >= 12 && worthMatching(tok, false))) out.push({ value: tok, compact: compact(tok), category: "never-share-file", rule });
  if (c.length < SHINGLE + STEP) {
    if (c.length >= 10) out.push({ value: text.trim(), compact: c, category: "never-share-file", rule });
    return { shingles: null, exact: out };
  }
  const set = new Set<string>();
  for (let i = 0; i + SHINGLE <= c.length; i += STEP) set.add(c.slice(i, i + SHINGLE));
  return { shingles: { file, set }, exact: out };
}

// ---- the scan ----

export interface Secrets {
  exact: Exact[];
  shingles: Shingles[];
}

export interface Field {
  field: string;
  text: string;
}

// The runs of letters and digits that look like pieces of a key (they have a
// digit, or a capital inside), joined. "first part Zt4mQ9vL, then 2xR8pW1n"
// gives "zt4mq9vl2xr8pw1n": the words put between the pieces drop out.
export const pieces = (s: string): string =>
  (s.match(/[A-Za-z0-9]+/g) ?? []).filter((w) => /\d/.test(w) || /[a-z][A-Z]/.test(w)).join("").toLowerCase();

// A piece of a secret is as bad as all of it. The guard counts how much of
// each random-looking value (sixteen or more letters and digits, not a whole
// URL) a message carries, in runs of GRAM with a letter and a digit, in any
// reading of the message. COVER characters of one value is a hold, whether
// they come in one message or spread over the recent ones to that contact.
// Only characters after the value's fixed prefix count (see fixedPrefix):
// "sk_live_" and four characters is four, not twelve.
const GRAM = 6;
// A run with no digit (a letters-only token, or the half of one that has no
// digit) is counted in longer grams with at least LONG_DISTINCT different
// characters, which words and names do not give.
const LONG = 12;
const LONG_DISTINCT = 9;
const HISTORY = 64_000; // characters of earlier messages looked at
const COVER = 8;
type Grams = Map<string, { e: Exact; at: number }[]>;
const GRAM_SIZES = [GRAM, LONG];
const gramOk = (g: string): boolean => (g.length === GRAM ? /[a-z]/.test(g) && /[0-9]/.test(g) : /[a-z]/.test(g) && new Set(g).size >= LONG_DISTINCT);
// Long grams only for values that are one token. In a value with spaces, a
// run of twelve letters is most likely words, which ordinary text repeats.
function grams(exact: Exact[]): Grams {
  const out: Grams = new Map();
  for (const e of exact) {
    if (e.compact.length < 16 || e.whole || entropy(e.compact) < 3) continue;
    for (const n of /\s/.test(e.value) ? [GRAM] : GRAM_SIZES)
    for (let i = 0; i + n <= e.compact.length; i++) {
      if (i + n <= (e.fixed ?? 0)) continue; // all prefix
      const g = e.compact.slice(i, i + n);
      if (!gramOk(g)) continue;
      const list = out.get(g) ?? [];
      // A gram that repeats inside a value is credited once, at its first place.
      if (list.some((h) => h.e === e)) continue;
      if (list.length < 8) list.push({ e, at: i });
      out.set(g, list);
    }
  }
  return out;
}

// Which characters of each value the streams carry. Each distinct gram seen
// counts once, however often it appears.
function cover(streams: string[], index: Grams, into = new Map<Exact, Set<number>>()): Map<Exact, Set<number>> {
  if (!index.size) return into;
  const seen = new Set<string>();
  for (const s of streams) {
    for (const n of GRAM_SIZES)
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);
      if (seen.has(g)) continue;
      seen.add(g);
      for (const { e, at } of index.get(g) ?? []) {
        const set = into.get(e) ?? new Set<number>();
        for (let k = Math.max(at, e.fixed ?? 0); k < at + n; k++) set.add(k);
        into.set(e, set);
      }
    }
  }
  return into;
}

// What the gram counting looks at in one message: every reading of every field, flattened two ways.
function streams(fields: Field[]): string[] {
  const out: string[] = [];
  for (const f of fields) for (const x of views(f.text).list) out.push(compact(x.text), pieces(x.text));
  return out;
}

// Lookups over one set of secrets, built once for it. With a large
// never-share file there are tens of thousands of values; each reading of a
// message is then walked once, not searched once per value.
const KEYLEN = 10;
interface Prepared {
  byStart: Map<string, Exact[]>; // values of KEYLEN or more letters and digits, by their first KEYLEN
  short: Exact[]; // the rest, which only count as written
  grams: Grams;
}
const PREPARED = new WeakMap<Secrets, Prepared>();
function prepare(s: Secrets): Prepared {
  const known = PREPARED.get(s);
  if (known) return known;
  const byStart = new Map<string, Exact[]>();
  const short: Exact[] = [];
  for (const e of s.exact) {
    if (e.compact.length < KEYLEN) {
      short.push(e);
      continue;
    }
    const k = e.compact.slice(0, KEYLEN);
    const list = byStart.get(k);
    if (list) list.push(e);
    else byStart.set(k, [e]);
  }
  const p = { byStart, short, grams: grams(s.exact) };
  PREPARED.set(s, p);
  return p;
}

// The values whose letters and digits appear whole, in a row, in `flat`.
function within(flat: string, p: Prepared, into: Set<Exact>, urls: boolean): void {
  for (let i = 0; i + KEYLEN <= flat.length; i++) {
    const list = p.byStart.get(flat.slice(i, i + KEYLEN));
    if (list) for (const e of list) if ((urls || !e.whole) && flat.startsWith(e.compact, i)) into.add(e);
  }
}

// The parts of a check that look at one message alone. Returns what the
// part across messages needs from it.
function scanOne(fields: Field[], secrets: Secrets, p: Prepared, add: (f: Finding) => void): string[] {
  const now: string[] = [];
  for (const { field, text } of fields) {
    if (!text) continue;
    const vs = views(text);
    if (vs.incomplete) add({ category: "too-much-to-check", rule: "guard-limits", field, how: "plain", start: 0, end: text.length });
    for (const v of vs.list) {
      const whole = v.span ?? [0, text.length];
      for (const h of patternHits(v.text, /(?:^|>)rot13(?:>|$)/.test(v.how))) {
        const span = v.how === "plain" ? [h.start, h.end] : whole;
        add({ category: h.category, rule: h.rule, field, how: v.how, start: span[0]!, end: span[1]! });
      }
      const flat = compact(v.text);
      const bits = pieces(v.text);
      now.push(flat, bits);
      // A value written as it is also shows in `flat`, so one walk finds both.
      const hits = new Set<Exact>();
      within(flat, p, hits, true);
      within(bits, p, hits, false);
      for (const e of p.short) if (v.text.includes(e.value)) hits.add(e);
      for (const e of hits) {
        const at = v.text.indexOf(e.value);
        if (at >= 0) add({ category: e.category, rule: e.rule, field, how: v.how, start: v.how === "plain" ? at : whole[0], end: v.how === "plain" ? at + e.value.length : whole[1] });
        else add({ category: e.category, rule: e.rule, field, how: v.how === "plain" ? "split" : `${v.how}>split`, start: whole[0], end: whole[1] });
      }
      for (const s of secrets.shingles) {
        for (let i = 0; i + SHINGLE <= flat.length; i++) {
          if (s.set.has(flat.slice(i, i + SHINGLE))) {
            add({ category: "never-share-file", rule: `never-share:${s.file}`, field, how: v.how, start: whole[0], end: whole[1] });
            break;
          }
        }
      }
    }
  }
  return now;
}

// The part of a check that depends on what was sent before. `now` is what
// scanOne returned for this message.
function across(fields: Field[], now: string[], p: Prepared, earlier: Field[][], add: (f: Finding) => void): void {
  const first = fields[0];
  const where = { field: first?.field ?? "body", start: 0, end: first?.text.length ?? 0 };
  // Short pieces (under six characters) sent one per message: join the
  // key-like runs of the recent messages and this one, and look for COVER
  // characters of a value, after its prefix, that reach into this message.
  if (earlier.length) {
    const tail = (m: Field[]): string => m.map((f) => pieces(f.text)).join("");
    const before = earlier.map(tail).join("").slice(-HISTORY);
    const joined = before + tail(fields);
    const done = new Set<Exact>();
    for (let i = Math.max(0, before.length - COVER + 1); i + COVER <= joined.length; i++) {
      const w = joined.slice(i, i + COVER);
      if (!/[a-z]/.test(w) || !/[0-9]/.test(w)) continue;
      // Every value this window is part of shares a gram with it that has a
      // letter and a digit; look the values up by that gram.
      let j = 0;
      while (j + GRAM <= COVER && !(/[a-z]/.test(w.slice(j, j + GRAM)) && /[0-9]/.test(w.slice(j, j + GRAM)))) j++;
      for (const { e } of p.grams.get(w.slice(j, j + GRAM)) ?? []) {
        if (done.has(e) || e.compact.indexOf(w, e.fixed ?? 0) < 0) continue;
        done.add(e);
        add({ category: e.category, rule: e.rule, how: "across messages", ...where });
      }
    }
  }
  if (p.grams.size) {
    const here = cover(now, p.grams);
    const before = earlier.length ? cover(earlier.flatMap(streams), p.grams) : new Map<Exact, Set<number>>();
    for (const [e, got] of here) {
      const was = before.get(e) ?? new Set<number>();
      const fresh = [...got].filter((k) => !was.has(k));
      if (!fresh.length || was.size + fresh.length < COVER) continue;
      add({ category: e.category, rule: e.rule, how: got.size >= COVER ? "part" : "across messages", ...where });
    }
  }
}

const collector = (): { add: (f: Finding) => void; list: () => Finding[] } => {
  const found = new Map<string, Finding>();
  return {
    add: (f) => {
      const k = `${f.field} ${f.rule} ${f.how}`;
      if (!found.has(k)) found.set(k, f);
    },
    list: () => [...found.values()],
  };
};

// `earlier` is what this side recently sent the same contact, oldest first.
export function scan(fields: Field[], secrets: Secrets, earlier: Field[][] = []): Finding[] {
  return scanKeeping(fields, secrets, earlier).findings;
}

function scanKeeping(fields: Field[], secrets: Secrets, earlier: Field[][]): { findings: Finding[]; now: string[] } {
  const p = prepare(secrets);
  const c = collector();
  const now = scanOne(fields, secrets, p, c.add);
  across(fields, now, p, earlier, c.add);
  return { findings: c.list(), now };
}

// Every string in a body, named by its path. Keys, ids and hashes the
// protocol fills in are left out: they are not anyone's words.
const STRUCTURAL = new Set(["participants", "parties", "proposalId", "supersedes", "contractHash", "via", "approval", "kind"]);
export function fieldsOf(body: unknown, path = ""): Field[] {
  if (typeof body === "string") return [{ field: path || "body", text: body }];
  if (Array.isArray(body)) return body.flatMap((x, i) => fieldsOf(x, path ? `${path}.${i}` : String(i)));
  if (body && typeof body === "object") {
    return Object.entries(body as Record<string, unknown>).flatMap(([k, v]) => (STRUCTURAL.has(k) ? [] : fieldsOf(v, path ? `${path}.${k}` : k)));
  }
  return [];
}

// ---- held messages ----

export type HeldState = "held" | "releasing" | "released" | "dropped" | "unguarded";

export interface Held {
  id: string;
  at: number;
  state: HeldState;
  contactRoot: string;
  threadId: string | null;
  type: string;
  body: unknown; // null once released or dropped
  reasons: GuardCategory[];
  findings: Finding[];
  eventId: string | null;
  closedAt: number | null;
}

interface HeldRow {
  id: string;
  at: number;
  state: HeldState;
  contact_root: string;
  thread_id: string | null;
  type: string;
  body: string | null;
  reasons: string;
  findings: string;
  event_id: string | null;
  closed_at: number | null;
}

const toHeld = (r: HeldRow): Held => ({
  id: r.id, at: r.at, state: r.state, contactRoot: r.contact_root, threadId: r.thread_id, type: r.type,
  body: r.body === null ? null : JSON.parse(r.body), reasons: JSON.parse(r.reasons), findings: JSON.parse(r.findings),
  eventId: r.event_id, closedAt: r.closed_at,
});

export interface GuardOptions {
  // The sending process's environment. Read at each check and never stored.
  env?: Record<string, string | undefined>;
  // The repository around this directory has its .env files checked too. null: none.
  cwd?: string | null;
  // Where warnings go. The guard being off is reported here on every use.
  log?: (line: string) => void;
  // Turns the guard off in this process. Only code that builds the node can
  // set it (tests). There is no environment variable: an agent with a shell
  // could set one. People use `cpart guard off`, which needs the passphrase.
  off?: boolean;
}

// The owner turning the guard off for a while: signed with the root key, so
// writing the row into state.db is not enough.
export const GUARD_OFF_DOMAIN = "guard-off/v1";
export const guardOffMessage = (rootKey: string, until: number): Uint8Array => utf8(`${rootKey}\n${until}`);
export const MAX_OFF_MINUTES = 8 * 60;

// What screen() worked out, for the second look inside the commit.
export interface Ticket {
  secrets: Secrets;
  now: string[];
  earlier: string; // the ids of the earlier messages it looked at
}

export type PathKind = "repo" | "never-share";

export interface Outgoing {
  contactRoot: string;
  threadId: string | null;
  type: string;
  body: unknown;
}

// Stopped by the second look inside the commit; becomes a HeldError after rollback.
export class Recheck extends Error {
  readonly out: Outgoing;
  readonly findings: Finding[];
  constructor(out: Outgoing, findings: Finding[]) {
    super("held for your human");
    this.out = out;
    this.findings = findings;
  }
}

// Far beyond anything the protocol lets through (eight attachments of 64,000
// characters and a 32,000 character text). Larger input is held unread.
const MAX_BODY = 1_000_000;

// A file's identity and last change, to tell when it must be read again.
function statKey(path: string): string | null {
  try {
    const st = lstatSync(path, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}`;
  } catch {
    return null;
  }
}

export class Guard {
  private db: DatabaseSync;
  private opts: GuardOptions;
  private now: () => number;
  private rootKey: string;
  // Never-share files parsed, by path, kept while the file is unchanged.
  private parsed = new Map<string, { key: string; result: ReturnType<typeof neverShare> }>();
  // The last set of secrets, kept while nothing it was built from has changed.
  private last: { key: string; secrets: Secrets } | null = null;
  private warnedCut = false;

  constructor(db: DatabaseSync, opts: GuardOptions, now: () => number, rootKey: string) {
    this.db = db;
    this.opts = opts;
    this.now = now;
    this.rootKey = rootKey;
    db.exec(`
      CREATE TABLE IF NOT EXISTS held (
        id TEXT PRIMARY KEY, at INTEGER NOT NULL, state TEXT NOT NULL, contact_root TEXT NOT NULL, thread_id TEXT,
        type TEXT NOT NULL, body TEXT, reasons TEXT NOT NULL, findings TEXT NOT NULL, event_id TEXT, closed_at INTEGER,
        claimed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS guard_paths (
        kind TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, path)
      );
      CREATE TABLE IF NOT EXISTS guard_off (
        id INTEGER PRIMARY KEY CHECK (id = 1), until INTEGER NOT NULL, sig TEXT NOT NULL, at INTEGER NOT NULL
      );
    `);
    const cols = new Set((db.prepare("PRAGMA table_info(held)").all() as { name: string }[]).map((c) => c.name));
    try {
      if (!cols.has("claimed_at")) db.exec("ALTER TABLE held ADD COLUMN claimed_at INTEGER");
    } catch (e) {
      // Another process opening the same home added it first.
      if (!/duplicate column/.test((e as Error).message)) throw e;
    }
  }

  private get env(): Record<string, string | undefined> {
    return this.opts.env ?? process.env;
  }

  // When the owner's `cpart guard off` ends, or null when the guard is on.
  // A row whose signature does not check out is ignored.
  offUntil(): number | null {
    const r = this.db.prepare("SELECT until, sig FROM guard_off WHERE id = 1").get() as { until: number; sig: string } | undefined;
    if (!r || r.until <= this.now()) return null;
    return verify(this.rootKey, GUARD_OFF_DOMAIN, guardOffMessage(this.rootKey, r.until), r.sig) ? r.until : null;
  }

  get off(): boolean {
    return this.opts.off === true || this.offUntil() !== null;
  }

  // Store the owner's signed word that the guard is off until `until`.
  setOff(until: number, sig: string): void {
    if (!verify(this.rootKey, GUARD_OFF_DOMAIN, guardOffMessage(this.rootKey, until), sig)) throw new Error("that is not signed by this identity's root key");
    this.db.prepare("INSERT INTO guard_off (id, until, sig, at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET until = excluded.until, sig = excluded.sig, at = excluded.at").run(until, sig, this.now());
  }

  // Turning it back on needs nobody's say.
  clearOff(): boolean {
    return this.db.prepare("DELETE FROM guard_off").run().changes > 0;
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.error(l)))(line);
  }

  // The repositories whose .env files count: the ones added, and the one the sending program runs in.
  private repos(): string[] {
    const repos = new Set(this.paths("repo"));
    const cwd = this.opts.cwd === undefined ? process.cwd() : this.opts.cwd;
    const here = cwd === null ? null : repoRoot(cwd);
    if (here) repos.add(here);
    return [...repos];
  }

  // What is checked for exact values right now. Files are read again when
  // they change, so an edited .env file counts at once. What was read is kept
  // in this process's memory while nothing changes, never written anywhere.
  secrets(): Secrets {
    const env = envValues(this.env);
    const limit = walkLimit();
    const configs: string[] = [];
    const envFiles = this.repos().flatMap((repo) => dotenvFiles(repo, limit, configs));
    const home = homeValues(this.env.HOME);
    if (limit.cut.size && !this.warnedCut) {
      this.warnedCut = true;
      this.log(`Counterpart guard: the .env search stopped early in ${[...limit.cut].join(", ")}. .env files deeper than ${WALK_DEPTH} directories or past the first ${WALK_DIRS} directories are not checked. See: cpart guard`);
    }
    const files = this.paths("never-share");
    const key = createHash("sha256")
      .update(JSON.stringify([env.map((e) => [e.rule, e.value]), envFiles.map((f) => [f, statKey(f)]), configs.map((f) => [f, statKey(f)]), home.files.map((f) => [f, statKey(f)]), files.map((f) => [f, statKey(f)])]))
      .digest("base64");
    if (this.last?.key === key) return this.last.secrets;

    const exactList: Exact[] = [...env];
    for (const f of envFiles) exactList.push(...dotenvValues(f));
    for (const f of configs) exactList.push(...configValues(f));
    exactList.push(...home.exact);
    const shingles: Shingles[] = [];
    const parsed = new Map<string, { key: string; result: ReturnType<typeof neverShare> }>();
    for (const file of files) {
      const k = statKey(file) ?? "";
      const known = this.parsed.get(file);
      const result = known && known.key === k ? known.result : neverShare(file);
      parsed.set(file, { key: k, result });
      exactList.push(...result.exact);
      if (result.shingles) shingles.push(result.shingles);
    }
    this.parsed = parsed;
    const seen = new Set<string>();
    const secrets = { exact: exactList.filter((e) => !seen.has(e.value) && seen.add(e.value)), shingles };
    this.last = { key, secrets };
    return secrets;
  }

  check(body: unknown, contactRoot?: string): Finding[] {
    return this.checkKeeping(body, contactRoot).findings;
  }

  private checkKeeping(body: unknown, contactRoot?: string): { findings: Finding[]; ticket: Ticket | null } {
    const fields = fieldsOf(body);
    if (fields.reduce((n, f) => n + f.text.length, 0) > MAX_BODY) return { findings: [{ category: "too-much-to-check", rule: "guard-limits", field: "body", how: "plain", start: 0, end: 0 }], ticket: null };
    // A protection that has stopped working stops everything until the owner
    // restores the file or removes it; otherwise its text would go out unchecked.
    const broken = this.paths("never-share").filter((f) => fileProblem(f) !== null);
    if (broken.length) return { findings: broken.map((f) => ({ category: "never-share-unreadable", rule: `never-share:${f}`, field: "body", how: "plain", start: 0, end: 0 })), ticket: null };
    const secrets = this.secrets();
    const earlier = contactRoot ? this.earlier(contactRoot) : { fields: [], ids: "" };
    const r = scanKeeping(fields, secrets, earlier.fields);
    return { findings: r.findings, ticket: { secrets, now: r.now, earlier: earlier.ids } };
  }

  // What this side sent the contact in the last day, up to eight events,
  // oldest first, and their ids.
  private earlier(contactRoot: string): { fields: Field[][]; ids: string } {
    const rows = this.db
      .prepare("SELECT e.id, e.json FROM events e JOIN threads t ON t.id = e.thread_id WHERE e.mine = 1 AND t.contact_root = ? AND e.received_at > ? ORDER BY e.ord DESC LIMIT 8")
      .all(contactRoot, this.now() - 24 * 3600_000) as { id: string; json: string }[];
    // Newest first, whole, until HISTORY characters; then oldest first.
    const out: Field[][] = [];
    let left = HISTORY;
    for (const r of rows) {
      const fields = fieldsOf((JSON.parse(r.json) as { body: unknown }).body);
      const n = fields.reduce((a, f) => a + f.text.length, 0);
      if (n > left) {
        // A long one keeps its end, where a piece would join on.
        out.push(fields.map((f) => ({ ...f, text: f.text.slice(-Math.floor(left / fields.length)) })));
        break;
      }
      left -= n;
      out.push(fields);
    }
    return { fields: out.reverse(), ids: rows.map((r) => r.id).join(" ") };
  }

  // Throws HeldError, after storing the message, when it must not go out.
  // Returns what recheck() needs, or null when there is nothing to recheck.
  screen(out: Outgoing): Ticket | null {
    const { findings, ticket } = this.checkKeeping(out.body, out.contactRoot);
    const reasons = [...new Set(findings.map((f) => f.category))];
    if (this.off) {
      const until = this.offUntil();
      const why = until !== null ? `until ${new Date(until).toISOString()}, set with cpart guard off; cpart guard on ends it` : "turned off by the program that runs it";
      this.log(`COUNTERPART OUTBOUND GUARD IS OFF (${why}). ${out.type} sent unchecked${reasons.length ? `. The guard would have HELD it: ${reasons.join(", ")}` : ""}.`);
      if (reasons.length) this.store(out, "unguarded", reasons, findings, false);
      return null;
    }
    if (!reasons.length) return ticket;
    const id = this.store(out, "held", reasons, findings, true);
    throw new HeldError(id, reasons);
  }

  // The part of the check that depends on what was sent before, run again
  // inside the transaction that commits the message. Two messages screened at
  // the same time could each carry half of a value; the transaction makes the
  // second one see the first. It runs inside a write lock, so it does as
  // little as it can: when no message was sent to this contact since
  // screen(), there is nothing new to see; otherwise only the part across
  // messages runs again, with the secrets screen() already read. Throws
  // Recheck, which the caller turns into a hold once the transaction has been
  // rolled back.
  recheck(out: Outgoing, ticket: Ticket | null): void {
    if (!ticket || this.off) return;
    const earlier = this.earlier(out.contactRoot);
    if (earlier.ids === ticket.earlier) return;
    const c = collector();
    across(fieldsOf(out.body), ticket.now, prepare(ticket.secrets), earlier.fields, c.add);
    const findings = c.list();
    if (findings.length) throw new Recheck(out, findings);
  }

  // Store a message the recheck stopped, and say so the usual way.
  hold(r: Recheck): HeldError {
    const reasons = [...new Set(r.findings.map((f) => f.category))];
    return new HeldError(this.store(r.out, "held", reasons, r.findings, true), reasons);
  }

  private store(out: Outgoing, state: HeldState, reasons: GuardCategory[], findings: Finding[], keepBody: boolean): string {
    const id = randomId(9);
    this.db
      .prepare("INSERT INTO held (id, at, state, contact_root, thread_id, type, body, reasons, findings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, this.now(), state, out.contactRoot, out.threadId, out.type, keepBody ? JSON.stringify(out.body) : null, JSON.stringify(reasons), JSON.stringify(findings));
    return id;
  }

  // A release that was cut short (the process died before it committed) is held again.
  held(all = false): Held[] {
    const rows = this.db.prepare(`SELECT * FROM held ${all ? "" : "WHERE state IN ('held', 'releasing')"} ORDER BY at, rowid`).all() as unknown as HeldRow[];
    return rows.map(toHeld);
  }

  counts(): { held: number; unguarded: number } {
    const n = (states: string): number => (this.db.prepare(`SELECT COUNT(*) AS n FROM held WHERE state IN (${states})`).get() as { n: number }).n;
    return { held: n("'held', 'releasing'"), unguarded: n("'unguarded'") };
  }

  // A held message by id or the first four or more characters of it.
  find(ref: string): Held {
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(ref)) throw new Error("give the id `cpart held` prints, or its first 4 or more characters");
    const rows = this.db.prepare("SELECT * FROM held WHERE substr(id, 1, ?) = ?").all(ref.length, ref) as unknown as HeldRow[];
    if (rows.length === 0) throw new Error(`no held message "${ref}". See: cpart held --all`);
    if (rows.length > 1) throw new Error(`"${ref}" is the start of ${rows.length} ids; give more characters`);
    return toHeld(rows[0]!);
  }

  // Take a held message for sending. Only one caller wins. A claim older than
  // ten minutes belonged to a release that died before committing anything
  // (sending and marking it released are one transaction), so it can be taken again.
  claim(id: string): Held {
    const r = this.db
      .prepare("UPDATE held SET state = 'releasing', claimed_at = ? WHERE id = ? AND (state = 'held' OR (state = 'releasing' AND claimed_at < ?))")
      .run(this.now(), id, this.now() - 600_000);
    if (r.changes !== 1) throw new Error("that message is not held any more, or is being released. See: cpart held --all");
    return this.find(id);
  }

  unclaim(id: string): void {
    this.db.prepare("UPDATE held SET state = 'held', claimed_at = NULL WHERE id = ? AND state = 'releasing'").run(id);
  }

  // Called inside the transaction that commits the released event, so the
  // two happen together or not at all.
  released(id: string, eventId: string): void {
    const r = this.db.prepare("UPDATE held SET state = 'released', body = NULL, event_id = ?, closed_at = ? WHERE id = ? AND state = 'releasing'").run(eventId, this.now(), id);
    if (r.changes !== 1) throw new Error("that message is no longer being released. Nothing was sent.");
  }

  drop(id: string): Held {
    const h = this.find(id);
    const r = this.db.prepare("UPDATE held SET state = 'dropped', body = NULL, closed_at = ? WHERE id = ? AND (state = 'held' OR (state = 'releasing' AND claimed_at < ?))").run(this.now(), h.id, this.now() - 600_000);
    if (r.changes !== 1) throw new Error("that message is not held any more. See: cpart held --all");
    return { ...h, state: "dropped", body: null };
  }

  paths(kind: PathKind): string[] {
    return (this.db.prepare("SELECT path FROM guard_paths WHERE kind = ? ORDER BY at").all(kind) as { path: string }[]).map((r) => r.path);
  }

  // Stored by its real path, so a link cannot later point somewhere else.
  addPath(kind: PathKind, path: string): string {
    const abs = realpathSync(resolve(path));
    const st = statSync(abs);
    if (kind === "repo" && !st.isDirectory()) throw new Error(`${abs} is not a directory`);
    if (kind === "never-share" && !st.isFile()) throw new Error(`${abs} is not a file`);
    if (kind === "never-share" && st.size > MAX_FILE) throw new Error(`${abs} is larger than ${MAX_FILE / 1024 / 1024} MB. Split it, or mark the parts that matter`);
    this.db.prepare("INSERT OR IGNORE INTO guard_paths (kind, path, at) VALUES (?, ?, ?)").run(kind, abs, this.now());
    return abs;
  }

  // Registered paths that give no protection right now, and why.
  problems(): string[] {
    const out: string[] = [];
    for (const f of this.paths("never-share")) {
      const p = fileProblem(f);
      if (p) out.push(`${f} ${p}`);
    }
    for (const r of this.paths("repo")) if (!existsSync(r)) out.push(`${r} cannot be found`);
    const limit = walkLimit();
    for (const r of this.repos()) dotenvFiles(r, limit);
    for (const r of limit.cut) out.push(`${r}: .env files deeper than ${WALK_DEPTH} directories, or past the first ${WALK_DIRS} directories searched, are not checked`);
    return out;
  }

  removePath(kind: PathKind, path: string): boolean {
    const r = this.db.prepare("DELETE FROM guard_paths WHERE kind = ? AND (path = ? OR path = ?)").run(kind, path, resolve(path));
    return r.changes > 0;
  }
}
