import type { Counterpart } from "@counterpart/daemon";
import { type Share, addShare, readBundle, readShare, removeShare, shareRules } from "@counterpart/frontdesk";

// cpart share: let the front desk read files from your repository for one
// contact. The logic is in @counterpart/frontdesk; this is the command line.

export const SHARE_USAGE = `  cpart share <contact> --repo <path> <path or "glob">... [--allow <sensitive path>]...
                                                                  let the front desk read these committed files. Paths are relative
                                                                  to the repository root. Quote globs: "src/**/*.ts"
  cpart share list [contact]                                      what each contact's front desk can read now, and what it skips
  cpart share remove <contact> <path or glob>... | --all`;

const SHOW = 40;

interface Opts {
  repo?: string;
  allow?: string[];
  all?: boolean;
  json?: boolean;
  safe: (s: string) => string;
}

function describe(contact: string, s: Share, patterns: string[], safe: (s: string) => string): string {
  const kb = (n: number): string => (n < 1024 ? `${n} bytes` : `${Math.round(n / 1024)} KB`);
  const lines = [
    `${contact}'s front desk can read ${s.files.length} file${s.files.length === 1 ? "" : "s"} (${kb(s.bytes)}) from ${safe(s.repo)} at ${s.commit.slice(0, 12)}, the current HEAD.`,
    `  shared: ${patterns.map((p) => safe(p)).join("  ")}`,
    ...s.files.slice(0, SHOW).map((f) => `  ${safe(f.path)}`),
    ...(s.files.length > SHOW ? [`  ... and ${s.files.length - SHOW} more (--json lists them all)`] : []),
  ];
  if (s.skipped.length) {
    lines.push(`Skipped ${s.skipped.length}, never shown to the model:`);
    for (const k of s.skipped.slice(0, SHOW)) lines.push(`  ${safe(k.path)}  ${safe(k.reason)}`);
    if (s.skipped.length > SHOW) lines.push(`  ... and ${s.skipped.length - SHOW} more`);
  }
  return lines.join("\n");
}

const json = (contact: string, s: Share) => ({ contact, repo: s.repo, commit: s.commit, hash: s.hash, files: s.files.map((f) => ({ path: f.path, blob: f.blob, bytes: Buffer.byteLength(f.text) })), skipped: s.skipped });

export function shareCommand(node: Counterpart, home: string, args: string[], o: Opts): { human: string; data: unknown } {
  if (args[0] === "list") {
    const contacts = args[1] ? [node.contact(args[1])] : node.contacts();
    const parts: string[] = [];
    const data: unknown[] = [];
    for (const c of contacts) {
      const rules = shareRules(home, c.rootKey);
      const s = readShare(home, c.rootKey);
      const bundle = readBundle(home, c.name).files.length;
      if (!s) {
        if (args[1] || bundle) parts.push(`Nothing from a repository is shared with ${c.name}.${bundle ? ` ${bundle} bundle file(s) are: cpart bundle list ${c.name}` : ""}`);
        continue;
      }
      parts.push(describe(c.name, s, rules.map((r) => (r.kind === "allow" ? `${r.pattern} (allowed)` : r.pattern)), o.safe) + (bundle ? `\nAlso ${bundle} bundle file(s): cpart bundle list ${c.name}` : ""));
      data.push({ ...json(c.name, s), rules });
    }
    return { human: parts.length ? parts.join("\n\n") : "Nothing from a repository is shared with anyone.", data };
  }
  if (args[0] === "remove") {
    if (!args[1]) throw new Error("usage: cpart share remove <contact> <path or glob>... | --all");
    const c = node.contact(args[1]);
    if (!o.all && args.length < 3) throw new Error("name the paths or globs to stop sharing, or pass --all");
    const n = removeShare(home, c.rootKey, o.all ? "all" : args.slice(2));
    const left = readShare(home, c.rootKey);
    return { human: `Removed ${n} rule${n === 1 ? "" : "s"}. ${left ? `${c.name}'s front desk can still read ${left.files.length} file(s). See: cpart share list ${c.name}` : `Nothing from a repository is shared with ${c.name} now.`}`, data: { removed: n, left: left ? json(c.name, left) : null } };
  }
  if (!args[0]) throw new Error(`usage:\n${SHARE_USAGE}`);
  const c = node.contact(args[0]);
  const patterns = args.slice(1);
  const existing = shareRules(home, c.rootKey);
  const repo = o.repo ?? existing[0]?.repo;
  if (!repo) throw new Error("give the repository: cpart share <contact> --repo <path> <path or glob>...");
  if (patterns.length === 0 && !o.allow?.length) throw new Error("name the files to share, relative to the repository root, like docs/api.md or \"src/**/*.ts\"");
  const s = addShare(home, c.rootKey, repo, patterns, o.allow ?? []);
  const rules = shareRules(home, c.rootKey);
  const human = `${describe(c.name, s, rules.map((r) => (r.kind === "allow" ? `${r.pattern} (allowed)` : r.pattern)), o.safe)}
Each time it answers, the front desk reads these again from the latest commit. Uncommitted changes are never read.
Every line it sends must quote one of these files, and code checks the quote. Turn it on with: cpart desk on ${c.name}`;
  return { human, data: { ...json(c.name, s), rules } };
}

// One line for cpart desk status.
export function sharedSummary(home: string, contact: { name: string; rootKey: string }): string {
  const bundle = readBundle(home, contact.name).files.length;
  let repo = "";
  try {
    const s = readShare(home, contact.rootKey);
    if (s) repo = `${s.files.length} repository file(s)`;
  } catch (e) {
    repo = `repository share unreadable: ${(e as Error).message}`;
  }
  return [`${bundle} bundle file(s)`, repo].filter(Boolean).join(" and ") + " shared";
}
