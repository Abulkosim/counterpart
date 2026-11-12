import { randomBytes } from "node:crypto";

export const CAPS = {
  message: 4000,
  messageMax: 16000,
  total: 32000,
  events: 50,
  goal: 200,
  reason: 200,
  threads: 50,
  // One read_contract result, shared by the text and the attachments, and the
  // text's share of it. Both count the "| " that starts every line.
  contract: 60000,
  contractText: 40000,
  agreement: 60000,
} as const;

// C0 and C1 controls except tab and newline, soft hyphen, bidi marks and
// overrides, zero-width and other invisible characters, line and paragraph
// separators, Unicode tag characters and lone surrogates.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\ud800-\udfff\u{e0000}-\u{e0fff}]/gu;
const ENVELOPE_LIKE = /<<(?=\s*\/?\s*(?:peer|my|end|goal|boundary|agreement)\b)/gi;

const hex = (c: string): string => `\\u{${c.codePointAt(0)!.toString(16)}}`;

// Text that keeps its line breaks but cannot hide characters, drive a
// terminal or look like one of our envelope lines.
export function sanitize(text: string): string {
  return text.replace(UNSAFE, hex).replace(ENVELOPE_LIKE, "<\\<");
}

export function oneLine(text: string, cap: number): string {
  const s = sanitize(text).replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return s.length > cap ? `${s.slice(0, cap)} [truncated, ${s.length} characters in all]` : s;
}

// A fresh boundary per call. A peer cannot know it when writing, and it is
// regenerated in the unlikely case that text already contains it.
export function newBoundary(texts: string[]): string {
  for (;;) {
    const b = randomBytes(9).toString("base64url");
    if (!texts.some((t) => t.includes(b))) return b;
  }
}

export interface Enveloped {
  text: string;
  truncated: boolean;
}

export interface EnvelopeFields {
  boundary: string;
  mine: boolean;
  from: string;
  kind: "message" | "thread-goal";
  ord: number;
  at: number;
}

// Every line of the body is prefixed, so no line of peer text can start with
// an envelope marker whatever it contains.
function block(head: string, body: string, boundary: string): string {
  return `<<${head}>>\n${body.split("\n").map((l) => `| ${l}`).join("\n")}\n<<end boundary=${boundary}>>`;
}

export function envelope(raw: string, cap: number, f: EnvelopeFields): Enveloped {
  const clean = sanitize(raw);
  const truncated = clean.length > cap;
  const head = [
    f.mine ? "my-message" : "peer-message",
    `boundary=${f.boundary}`,
    f.mine ? 'from="me"' : `from="${f.from}"`,
    ...(f.kind === "thread-goal" ? ['kind="thread-goal"'] : []),
    `ord=${f.ord}`,
    `at=${iso(f.at)}`,
    ...(truncated ? [`truncated="first ${cap} of ${clean.length} characters"`] : []),
  ].join(" ");
  return { text: block(head, truncated ? clean.slice(0, cap) : clean, f.boundary), truncated };
}

export interface ContractFields {
  boundary: string;
  mine: boolean;
  from: string;
  field: "title" | "text" | "attachment";
  // Attachment name and kind. Both are checked against fixed patterns before they reach here.
  name?: string;
  kind?: string;
  offset?: number;
}

export interface ContractEnveloped extends Enveloped {
  // Length after escaping. Offsets count these characters.
  length: number;
  end: number;
}

// One field of a contract. `offset` counts characters after escaping. `cap`
// bounds what is printed, line prefixes included, so a part full of control
// characters or line breaks cannot grow past it.
export function contractEnvelope(raw: string, cap: number, f: ContractFields): ContractEnveloped {
  const clean = sanitize(raw);
  const start = Math.min(f.offset ?? 0, clean.length);
  let end = start;
  for (let cost = 2; end < clean.length; end++) {
    cost += clean[end] === "\n" ? 3 : 1;
    if (cost > cap) break;
  }
  const truncated = start > 0 || end < clean.length;
  const head = [
    f.mine ? "my-contract" : "peer-contract",
    `boundary=${f.boundary}`,
    f.mine ? 'from="me"' : `from="${f.from}"`,
    `field="${f.field}"`,
    ...(f.name !== undefined ? [`name="${oneLine(f.name, 80)}"`] : []),
    ...(f.kind !== undefined ? [`kind="${oneLine(f.kind, 20)}"`] : []),
    ...(truncated ? [`truncated="characters ${start} to ${end} of ${clean.length}"`] : []),
  ].join(" ");
  return { text: block(head, clean.slice(start, end), f.boundary), truncated, length: clean.length, end };
}

// A short piece of text on one line: a goal, a contract title, a decline reason.
export function inlineEnvelope(tag: string, text: string, cap: number, boundary: string): string {
  return `<<${tag} boundary=${boundary}>> ${oneLine(text, cap)} <<end boundary=${boundary}>>`;
}

export function goalEnvelope(goal: string, boundary: string): string {
  return inlineEnvelope("peer-goal", goal, CAPS.goal, boundary);
}

// JSON that parses to the same value but holds no character that sanitize
// would escape and nothing that looks like an envelope line. Such characters
// can only sit inside JSON strings, where a \u escape means the same thing.
export function jsonSafe(json: string): string {
  const esc = (c: string): string => Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");
  return json.replace(UNSAFE, esc).replace(ENVELOPE_LIKE, "<\\u003c");
}

export function jsonEnvelope(tag: string, json: string, boundary: string): string {
  return block(`${tag} boundary=${boundary}`, jsonSafe(json), boundary);
}

export function iso(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 19) + "Z";
}
