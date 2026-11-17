import type { StoredEvent } from "@counterpart/daemon";
import { readBundle } from "./bundle.ts";
import { checkCitations } from "./cite.ts";
import { ASK, repoSystemPrompt, systemPrompt } from "./prompt.ts";
import { render, select } from "./retrieve.ts";
import { type Share, readShare, rulesHash, shareRules } from "./share.ts";

// What the front desk shows the model for one contact, and how it checks the
// reply. Two kinds: a bundle of copied files (the reply is sent as written),
// or a share from the owner's repository (every line of the reply must carry
// a citation that code checks). Used by the desk and by the eval, so both run
// the same code.

export const ASK_CHARS = 300;
export const REPLY_CHARS = 6000;
export const TEXT = {
  noMaterial: (owner: string) => `This is ${owner}'s front desk. Nothing has been shared with you here yet, so I can't answer. ${owner} will see your message.`,
  outOfBudget: (owner: string) => `This is ${owner}'s front desk. I've used the replies ${owner} allowed for this thread. ${owner} will see the rest of your messages.`,
  asked: (owner: string) => `I can't answer that from what ${owner} has shared. I've passed the question to ${owner}.`,
};

export interface Contact {
  name: string;
  rootKey: string;
}
export type Material =
  | { kind: "bundle"; hash: string; system: string; names: string[] }
  | { kind: "repo"; hash: string; rulesHash: string; bundleHash: string; system: string; share: Share; files: Map<string, string>; shown: number; ranked: boolean };

export interface Composed {
  reply: string | null; // null: nothing to send
  asks: string[];
  files: string[]; // files the reply drew on
  detail: string | null;
}

// The words the desk ranks the shared files against: the thread's goal and
// the contact's latest messages, the newest counted twice. These come from the
// other side and only decide which shared lines are shown, never what is shared.
export function queryFrom(goal: string, log: StoredEvent[]): string {
  const theirs = log.filter((e) => !e.mine && e.type === "talk.posted" && e.status === "applied").map((e) => (e.body as { text: string }).text);
  const last = theirs.slice(-3);
  return [goal, ...last, last.at(-1) ?? ""].join("\n").slice(0, 8000);
}

export function prepare(home: string, contact: Contact, owner: string, query: string): Material | null {
  const bundle = readBundle(home, contact.name);
  const share = readShare(home, contact.rootKey);
  if (!share) {
    if (bundle.files.length === 0) return null;
    return { kind: "bundle", hash: bundle.hash, system: systemPrompt(owner, contact.name, bundle), names: bundle.files.map((f) => f.name) };
  }
  // Bundle files given to the same contact are shared too, under bundle:<name>.
  const docs = [...share.files.map((f) => ({ path: f.path, text: f.text })), ...bundle.files.map((f) => ({ path: `bundle:${f.name}`, text: f.text }))];
  if (docs.length === 0) return null;
  const sel = select(docs, query);
  const files = new Map(docs.map((d) => [d.path, d.text]));
  return {
    kind: "repo",
    hash: share.hash,
    rulesHash: share.rulesHash,
    bundleHash: bundle.hash,
    share,
    files,
    shown: sel.chunks.length,
    ranked: sel.ranked,
    system: repoSystemPrompt(owner, contact.name, { commit: share.commit, paths: docs.map((d) => d.path), excerpts: sel.chunks.map(render).join("\n"), ranked: sel.ranked }),
  };
}

// Whether what the owner shared is still what it was when the model started.
// For a repository share a new commit does not count: the rules are the same,
// and the reply is checked against the commit the model was shown.
export function unchanged(home: string, contact: Contact, m: Material): boolean {
  const bundle = readBundle(home, contact.name);
  if (m.kind === "bundle") return shareRules(home, contact.rootKey).length === 0 && bundle.hash === m.hash;
  return rulesHash(shareRules(home, contact.rootKey)) === m.rulesHash && bundle.hash === m.bundleHash;
}

// Turn the model's raw text into what is sent. `question` is the contact's
// latest message, passed to the owner when the model wrote nothing usable.
export function compose(m: Material, raw: string, owner: string, question: string): Composed {
  const lines = raw.split("\n");
  const asks = lines.filter((l) => l.trimStart().startsWith(ASK)).map((l) => l.trimStart().slice(ASK.length).trim().slice(0, ASK_CHARS)).filter(Boolean);
  const body = lines.filter((l) => !l.trimStart().startsWith(ASK)).join("\n").trim();
  if (m.kind === "bundle") {
    let reply = body;
    if (asks.length > 0) reply = reply ? `${reply}\n\n${TEXT.asked(owner)}` : TEXT.asked(owner);
    return { reply: reply || null, asks, files: m.names.filter((n) => reply.includes(n)), detail: reply ? null : "empty reply" };
  }
  const c = checkCitations(body, m.files);
  const why = [...new Set(c.problems)].slice(0, 4).join("; ");
  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
  const detail = `commit ${m.share.commit.slice(0, 12)}, ${m.ranked ? `${n(m.shown, "excerpt", "excerpts")} picked` : "all shared text shown"}, ${n(c.citations.length, "citation", "citations")} checked, ${n(c.removed, "line", "lines")} removed${why ? ` (${why})` : ""}${m.share.skipped.length ? `, ${n(m.share.skipped.length, "file", "files")} skipped` : ""}`;
  if (c.kept === 0) {
    // Nothing checkable: the question goes to the owner, as when the model asks.
    const q = asks.length ? asks : [question.replace(/\s+/g, " ").trim().slice(0, ASK_CHARS) || "(an empty message)"];
    return { reply: TEXT.asked(owner), asks: q, files: [], detail };
  }
  // Cut whole checked lines, never part of one, so a citation cannot be cut
  // off the text it vouches for. Room is left for the fixed lines below.
  const kept: string[] = [];
  let size = 0;
  for (const l of c.text.split("\n")) {
    if (size + l.length + 1 > REPLY_CHARS - 400) break;
    kept.push(l);
    size += l.length + 1;
  }
  if (kept.length === 0) return { reply: TEXT.asked(owner), asks: asks.length ? asks : [question.replace(/\s+/g, " ").trim().slice(0, ASK_CHARS) || "(an empty message)"], files: [], detail: `${detail}, reply too long` };
  let reply = `${kept.join("\n")}${kept.length < c.kept ? "\n[cut short]" : ""}\n(Quoted from files as committed at ${m.share.commit.slice(0, 12)}.)`;
  if (asks.length > 0) reply += `\n\n${TEXT.asked(owner)}`;
  return { reply, asks, files: [...new Set(c.citations.map((x) => x.path))], detail };
}
