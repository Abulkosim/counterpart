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

import { existsSync, lstatSync, openSync, closeSync, readFileSync, readSync, readdirSync, realpathSync, statSync, fstatSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomId } from "@counterpart/protocol";

export type GuardCategory =
  | "private-key"
  | "cloud-credential"
  | "jwt"
  | "api-token"
  | "generic-secret"
  | "env-secret"
  | "dotenv-value"
  | "never-share-file"
  // The message holds more encoded text than the guard will decode, so part of it went unchecked.
  | "too-much-to-check";

export type Encoding = "plain" | "reversed" | "split" | "base64" | "hex" | "url" | "escaped";

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
    allow: /^(?:\*+|x+|\.+|password|passwd|pass|pwd|secret|changeme|example|postgres|root|admin|guest|test|dev|user|mysql|redis|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\[[^\]]*\]|\{\{.*\}\}|%[A-Za-z_]+%)$/i,
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

export function entropy(s: string): number {
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

// What the generic rule finds that is plainly not a value: a variable name
// followed by "=", an ellipsis, a template, an obvious stand-in.
const PLACEHOLDER = /\.\.\.|…|^[A-Z][A-Z0-9_]*=|^\$\{?[A-Za-z_]|<[^>]*>|\{\{|your[_-]|[_-]here$|example|placeholder|changeme|dummy|redacted|x{6,}|\*{3,}/i;
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

// Pattern hits in one piece of text, with gitleaks' own rules for which part
// of a match is the secret, entropy and allowlists.
const CHUNK = 4_000;
const OVERLAP = 1_000;

// `shape` is for text put through rot13: then only rules for fixed token
// shapes apply. Ordinary text comes out with its placeholders scrambled and
// its structure intact, which the loose rules would take for a secret.
export function patternHits(text: string, shape = false): Hit[] {
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

const MIN_VIEWS = 600; // and one more for every 8 characters of the field
const MIN_DECODED = 512 * 1024;
const MAX_CODES = 65_536;

// The readable stretches of decoded bytes. Random bytes (hashes, compressed
// data) give none of any length; text that was encoded comes back whole, even
// when the encoded run was cut at the wrong place or had words glued to it.
const UNREADABLE = /[�\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/;
function readable(s: string): string[] {
  return s.split(UNREADABLE).filter((x) => x.length >= 6);
}

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

const unescape = (s: string): string =>
  s.replace(/\\u([0-9a-fA-F]{4})|\\([nrt"\\/])/g, (_, h: string | undefined, c: string | undefined) => (h ? String.fromCharCode(parseInt(h, 16)) : c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c!));
// Pieces put on separate lines, between quotes, or joined with + in code.
const unsplit = (s: string): string => s.replace(/["'`]\s*\+\s*["'`]/g, "").replace(/["'`\s,;|]+/g, "");

// Every encoded run in a text, decoded: [kind, decoded, index, length].
function decodings(text: string): [string, string, number, number][] {
  const out: [string, string, number, number][] = [];
  // Hex, with or without separators, 0x or \x prefixes (the backslash doubled in JSON).
  for (const m of text.matchAll(/(?:(?:\\{1,2}x|0x)?[0-9a-fA-F]{2}[\s:,-]?){8,}/g)) {
    const hex = m[0].replace(/\\{1,2}x|0x|[\s:,-]/g, "");
    if (hex.length % 2 === 0) out.push(["hex", Buffer.from(hex, "hex").toString("utf8"), m.index, m[0].length]);
  }
  // Base64 in either alphabet, tried at each alignment in case it was cut out of a longer run.
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) {
    const s = m[0];
    if (/^[0-9a-fA-F]+$/.test(s)) continue;
    for (let skip = 0; skip < 4 && s.length - skip >= 8; skip++) out.push(["base64", Buffer.from(s.slice(skip), "base64").toString("utf8"), m.index, s.length]);
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
  const maxViews = Math.max(MIN_VIEWS, Math.ceil(text.length / 8));
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
    // Surface changes: at most two in a row, rot13 and folding only on what was written.
    if (surface < 2) {
      add(reverse(v.text), chain(v.how, "reversed"), v.span, depth, surface + 1);
      add(unsplit(v.text), chain(v.how, "split"), v.span, depth, surface + 1);
      if (/\\[nrtu"\\/]/.test(v.text)) add(unescape(v.text), chain(v.how, "escaped"), v.span, depth, surface + 1);
      if (depth === 0 && surface === 0) {
        add(rot13(v.text), "rot13", null, 0, 2);
        add(v.text.normalize("NFKC"), "folded", null, 0, 1);
      }
    }
    if (depth >= 3) continue;
    for (const [kind, decoded, at, len] of decodings(v.text)) {
      const span: View["span"] = v.how === "plain" ? [at, at + len] : v.span;
      for (const part of readable(decoded)) add(part, chain(v.how, kind), span, depth + 1, 0);
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
}

const SECRET_NAME = /secret|token|passw|pwd|passphrase|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth(?!or)|session|cookie|signing|salt|dsn|database[_-]?url|db[_-]?url|conn(?:ection)?[_-]?str|webhook|bearer|jwt|encryption[_-]?key|master[_-]?key|license[_-]?key/i;
const NOT_SECRET_NAME = /^(?:XDG_|DBUS_|SSH_AUTH_SOCK$|SSH_AGENT_PID$|GPG_|DESKTOP_SESSION$|SESSION_MANAGER$|TERM_SESSION_ID$|ITERM_SESSION_ID$|TMUX|KITTY_|WINDOWID$)|(?:_SOCK|_SOCKET|_PATH|_DIR|_FILE|_HOME|_PID|_HOST|_PORT|_USER|_USERNAME|_NAME|_EMAIL|_REGION|_ENDPOINT|_ID)$/i;
const DULL = /^(?:true|false|null|none|yes|no|on|off|localhost|development|production|staging|test|debug|info|warn|warning|error|enabled|disabled)$/i;

// Is this value worth holding a message over when it shows up exactly?
export function worthMatching(value: string, secretName: boolean): boolean {
  if (value.length < 8 || value.length > 8192) return false;
  if (DULL.test(value)) return false;
  if (/^[0-9]+$/.test(value) && value.length < 12) return false;
  if (/^[A-Za-z]+$/.test(value) && value.length < 12) return false;
  if (/^(?:\/|~\/|\.\.?\/|[A-Za-z]:\\)\S*$/.test(value)) return false; // a path
  // A URL is a secret when it has a user or password in it, or when a
  // secret-named variable holds it and a part of it looks like a key.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return /:\/\/[^/\s@]+@/.test(value) || (secretName && urlKeys(value).length > 0);
  if (secretName) return true;
  return tokenLike(value);
}

export const tokenLike = (v: string): boolean => v.length >= 16 && v.length <= 512 && !/\s/.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v) && entropy(v) >= 3.0;

// The parts of a URL that look like keys: a password, a path segment, a query value.
function urlKeys(value: string): string[] {
  const out: string[] = [];
  const pw = /:\/\/[^/\s:@]*:([^/\s@]+)@/.exec(value)?.[1];
  if (pw && pw.length >= 8) out.push(pw);
  const user = /:\/\/([^/\s:@]+)@/.exec(value)?.[1];
  if (user && tokenLike(user)) out.push(user);
  const rest = value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  for (const part of rest.split(/[/?&=#]+/)) if (tokenLike(part)) out.push(part);
  return out;
}

function exact(value: string, category: GuardCategory, rule: string): Exact[] {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  // A whole URL counts only whole: its host and path are not secret. The
  // parts that look like keys count on their own, pieces included.
  const out: Exact[] = [{ value, compact: compact(value), category, rule, ...(url ? { whole: true } : {}) }];
  if (url) for (const k of urlKeys(value)) out.push({ value: k, compact: compact(k), category, rule });
  return out;
}

export function envValues(env: Record<string, string | undefined>): Exact[] {
  const out: Exact[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || NOT_SECRET_NAME.test(name) || !SECRET_NAME.test(name)) continue;
    if (worthMatching(value, true)) out.push(...exact(value, "env-secret", `env:${name}`));
  }
  return out;
}

export function parseDotenv(text: string): { name: string; value: string }[] {
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
function readSmall(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(st.size, MAX_FILE));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".cache", ".turbo", "coverage"]);

// .env files anywhere in a repository, a few levels down, without following links.
export function dotenvFiles(root: string, limit = { dirs: 2000 }): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 5 || limit.dirs-- <= 0) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n)) walk(p, depth + 1);
      } else if (st.isFile() && (/^\.env(?:\..+)?$/.test(n) || /.\.env$/.test(n))) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

export function dotenvValues(file: string): Exact[] {
  const text = readSmall(file);
  if (text === null) return [];
  const out: Exact[] = [];
  for (const { name, value } of parseDotenv(text)) {
    const secretName = SECRET_NAME.test(name) && !NOT_SECRET_NAME.test(name);
    if (worthMatching(value, secretName)) out.push(...exact(value, "dotenv-value", `dotenv:${file}:${name}`));
  }
  return out;
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
export function fileProblem(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "cannot be read";
  }
  if (st.isSymbolicLink()) return "is a symbolic link";
  if (!st.isFile()) return "is not a file";
  if (st.size > MAX_FILE) return `is larger than ${MAX_FILE / 1024 / 1024} MB; only the start is checked`;
  return null;
}

export function neverShare(file: string): { shingles: Shingles | null; exact: Exact[] } {
  const text = readSmall(file);
  if (text === null) return { shingles: null, exact: [] };
  const c = compact(text);
  const rule = `never-share:${file}`;
  const out: Exact[] = [];
  for (const tok of text.split(/[\s"'`=:,;()[\]{}<>]+/)) if (tokenLike(tok) || (tok.length >= 12 && worthMatching(tok, false))) out.push({ value: tok, compact: compact(tok), category: "never-share-file", rule });
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
const GRAM = 6;
const COVER = 10;
type Grams = Map<string, { e: Exact; at: number }[]>;
function grams(exact: Exact[]): Grams {
  const out: Grams = new Map();
  for (const e of exact) {
    if (e.compact.length < 16 || e.whole) continue;
    for (let i = 0; i + GRAM <= e.compact.length; i++) {
      const g = e.compact.slice(i, i + GRAM);
      if (!/[a-z]/.test(g) || !/[0-9]/.test(g)) continue;
      const list = out.get(g) ?? [];
      list.push({ e, at: i });
      out.set(g, list);
    }
  }
  return out;
}

function cover(streams: string[], index: Grams, into = new Map<Exact, Set<number>>()): Map<Exact, Set<number>> {
  if (!index.size) return into;
  for (const s of streams) {
    for (let i = 0; i + GRAM <= s.length; i++) {
      const hits = index.get(s.slice(i, i + GRAM));
      if (!hits) continue;
      for (const { e, at } of hits) {
        const set = into.get(e) ?? new Set<number>();
        for (let k = at; k < at + GRAM; k++) set.add(k);
        into.set(e, set);
      }
    }
  }
  return into;
}

// What the gram counting looks at in one message: every reading of every field, flattened two ways.
function streams(fields: Field[]): { streams: string[]; incomplete: boolean } {
  const out: string[] = [];
  let incomplete = false;
  for (const f of fields) {
    const v = views(f.text);
    incomplete ||= v.incomplete;
    for (const x of v.list) out.push(compact(x.text), pieces(x.text));
  }
  return { streams: out, incomplete };
}

// `earlier` is what this side recently sent the same contact, oldest first.
export function scan(fields: Field[], secrets: Secrets, earlier: Field[][] = []): Finding[] {
  const found = new Map<string, Finding>();
  const add = (f: Finding): void => {
    const k = `${f.field} ${f.rule} ${f.how}`;
    if (!found.has(k)) found.set(k, f);
  };
  for (const { field, text } of fields) {
    if (!text) continue;
    const vs = views(text);
    if (vs.incomplete) add({ category: "too-much-to-check", rule: "guard-limits", field, how: "plain", start: 0, end: text.length });
    for (const v of vs.list) {
      const whole = v.span ?? [0, text.length];
      for (const h of patternHits(v.text, v.how === "rot13")) {
        const span = v.how === "plain" ? [h.start, h.end] : whole;
        add({ category: h.category, rule: h.rule, field, how: v.how, start: span[0]!, end: span[1]! });
      }
      const flat = compact(v.text);
      const bits = pieces(v.text);
      for (const e of secrets.exact) {
        const at = v.text.indexOf(e.value);
        if (at >= 0) {
          add({ category: e.category, rule: e.rule, field, how: v.how, start: v.how === "plain" ? at : whole[0], end: v.how === "plain" ? at + e.value.length : whole[1] });
        } else if (e.compact.length >= 10 && (flat.includes(e.compact) || (!e.whole && bits.includes(e.compact)))) {
          add({ category: e.category, rule: e.rule, field, how: v.how === "plain" ? "split" : `${v.how}>split`, start: whole[0], end: whole[1] });
        }
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
  const index = grams(secrets.exact);
  if (index.size) {
    const now = cover(streams(fields).streams, index);
    const before = earlier.length ? cover(earlier.flatMap((m) => streams(m).streams), index) : new Map<Exact, Set<number>>();
    const first = fields[0];
    for (const [e, here] of now) {
      const was = before.get(e) ?? new Set<number>();
      const fresh = [...here].filter((k) => !was.has(k));
      if (!fresh.length || was.size + fresh.length < COVER) continue;
      add({ category: e.category, rule: e.rule, field: first?.field ?? "body", how: here.size >= COVER ? "part" : "across messages", start: 0, end: first?.text.length ?? 0 });
    }
  }
  return [...found.values()];
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
  // Where warnings go. The off switch is reported here on every use.
  log?: (line: string) => void;
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

export class Guard {
  private db: DatabaseSync;
  private opts: GuardOptions;
  private now: () => number;

  constructor(db: DatabaseSync, opts: GuardOptions, now: () => number) {
    this.db = db;
    this.opts = opts;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS held (
        id TEXT PRIMARY KEY, at INTEGER NOT NULL, state TEXT NOT NULL, contact_root TEXT NOT NULL, thread_id TEXT,
        type TEXT NOT NULL, body TEXT, reasons TEXT NOT NULL, findings TEXT NOT NULL, event_id TEXT, closed_at INTEGER,
        claimed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS guard_paths (
        kind TEXT NOT NULL, path TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, path)
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

  // True while CPART_GUARD=off is set in the sending process. For tests and
  // the red-team comparison only.
  get off(): boolean {
    return this.env.CPART_GUARD === "off";
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.error(l)))(line);
  }

  // What is checked for exact values right now. Built fresh each time so a
  // changed .env file counts at once; nothing from it is kept.
  secrets(): Secrets {
    const exactList: Exact[] = [...envValues(this.env)];
    const shingles: Shingles[] = [];
    const repos = new Set(this.paths("repo"));
    const cwd = this.opts.cwd === undefined ? process.cwd() : this.opts.cwd;
    const here = cwd === null ? null : repoRoot(cwd);
    if (here) repos.add(here);
    const budget = { dirs: 4000 };
    for (const repo of repos) for (const f of dotenvFiles(repo, budget)) exactList.push(...dotenvValues(f));
    for (const file of this.paths("never-share")) {
      const n = neverShare(file);
      exactList.push(...n.exact);
      if (n.shingles) shingles.push(n.shingles);
    }
    return { exact: exactList, shingles };
  }

  check(body: unknown, contactRoot?: string): Finding[] {
    const fields = fieldsOf(body);
    if (fields.reduce((n, f) => n + f.text.length, 0) > MAX_BODY) return [{ category: "too-much-to-check", rule: "guard-limits", field: "body", how: "plain", start: 0, end: 0 }];
    return scan(fields, this.secrets(), contactRoot ? this.earlier(contactRoot) : []);
  }

  // What this side sent the contact in the last day, up to eight events,
  // oldest first. Long ones keep their ends, where a piece would join on.
  private earlier(contactRoot: string): Field[][] {
    const rows = this.db
      .prepare("SELECT e.json FROM events e JOIN threads t ON t.id = e.thread_id WHERE e.mine = 1 AND t.contact_root = ? AND e.received_at > ? ORDER BY e.ord DESC LIMIT 8")
      .all(contactRoot, this.now() - 24 * 3600_000) as { json: string }[];
    return rows.reverse().map((r) => fieldsOf((JSON.parse(r.json) as { body: unknown }).body).map((f) => ({ field: f.field, text: f.text.length > 8000 ? `${f.text.slice(0, 4000)} ${f.text.slice(-4000)}` : f.text })));
  }

  // Throws HeldError, after storing the message, when it must not go out.
  screen(out: Outgoing): void {
    const findings = this.check(out.body, out.contactRoot);
    const reasons = [...new Set(findings.map((f) => f.category))];
    if (this.off) {
      this.log(`COUNTERPART OUTBOUND GUARD IS OFF (CPART_GUARD=off). ${out.type} sent unchecked${reasons.length ? `. The guard would have HELD it: ${reasons.join(", ")}` : ""}.`);
      if (reasons.length) this.store(out, "unguarded", reasons, findings, false);
      return;
    }
    if (!reasons.length) return;
    const id = this.store(out, "held", reasons, findings, true);
    throw new HeldError(id, reasons);
  }

  // The part of the check that depends on what was sent before, run again
  // inside the transaction that commits the message. Two messages screened at
  // the same time could each carry half of a value; the transaction makes the
  // second one see the first. Throws Recheck, which the caller turns into a
  // hold once the transaction has been rolled back.
  recheck(out: Outgoing): void {
    if (this.off) return;
    const secrets = this.secrets();
    const fields = fieldsOf(out.body);
    const findings = scan(fields, { exact: secrets.exact, shingles: [] }, this.earlier(out.contactRoot)).filter((f) => f.how === "across messages");
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
    return out;
  }

  removePath(kind: PathKind, path: string): boolean {
    const r = this.db.prepare("DELETE FROM guard_paths WHERE kind = ? AND (path = ? OR path = ?)").run(kind, path, resolve(path));
    return r.changes > 0;
  }
}
