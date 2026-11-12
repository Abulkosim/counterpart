import { randomBytes } from "node:crypto";

export const CAPS = {
  message: 4000,
  messageMax: 16000,
  total: 32000,
  events: 50,
  goal: 200,
  reason: 200,
  threads: 50,
} as const;

// C0 and C1 controls except tab and newline, soft hyphen, bidi marks and
// overrides, zero-width and other invisible characters, line and paragraph
// separators, Unicode tag characters and lone surrogates.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\ud800-\udfff\u{e0000}-\u{e0fff}]/gu;
const ENVELOPE_LIKE = /<<(?=\s*\/?\s*(?:peer|my|end|goal|boundary)\b)/gi;

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
export function envelope(raw: string, cap: number, f: EnvelopeFields): Enveloped {
  const clean = sanitize(raw);
  const truncated = clean.length > cap;
  const body = (truncated ? clean.slice(0, cap) : clean).split("\n").map((l) => `| ${l}`).join("\n");
  const head = [
    f.mine ? "my-message" : "peer-message",
    `boundary=${f.boundary}`,
    f.mine ? 'from="me"' : `from="${f.from}"`,
    ...(f.kind === "thread-goal" ? ['kind="thread-goal"'] : []),
    `ord=${f.ord}`,
    `at=${iso(f.at)}`,
    ...(truncated ? [`truncated="first ${cap} of ${clean.length} characters"`] : []),
  ].join(" ");
  return { text: `<<${head}>>\n${body}\n<<end boundary=${f.boundary}>>`, truncated };
}

export function goalEnvelope(goal: string, boundary: string): string {
  return `<<peer-goal boundary=${boundary}>> ${oneLine(goal, CAPS.goal)} <<end boundary=${boundary}>>`;
}

export function iso(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 19) + "Z";
}
