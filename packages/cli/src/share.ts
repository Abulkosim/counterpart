import type { Counterpart } from "@counterpart/daemon";
import { type Share, type ShareRule, planShare, readBundle, readShare, removeShare, saveShare, shareRules } from "@counterpart/frontdesk";

// cpart share: let the front desk read files from your repository for one
// contact. The logic is in @counterpart/frontdesk; this is the command line.

export const SHARE_USAGE = `  cpart share <contact> --repo <path> <path or "glob">...
        [--allow <sensitive path>]...
      let the front desk read these committed files. Paths are relative to the
      repository root. Quote globs: "src/**/*.ts". You confirm in a terminal,
      with your passphrase if you have one
  cpart share list [contact]
      what the front desk can read for each contact now, and what it skips
  cpart share remove <contact> <path or glob>... | --all`;

const SHOW = 40;

interface Opts {
  repo?: string;
  allow?: string[];
  all?: boolean;
  json?: boolean;
  safe: (s: string) => string;
  gate: Gate;
}

function describe(contact: string, s: Share, patterns: string[], safe: (s: string) => string, show: number = SHOW): string {
  const kb = (n: number): string => (n < 1024 ? `${n} bytes` : `${Math.round(n / 1024)} KB`);
  const lines = [
    `Your front desk for ${contact} can read ${s.files.length} file${s.files.length === 1 ? "" : "s"} (${kb(s.bytes)}) from ${safe(s.repo)} at ${s.commit.slice(0, 12)}, the current HEAD.`,
    `  shared: ${patterns.map((p) => safe(p)).join("  ")}`,
    ...s.files.slice(0, show).map((f) => `  ${safe(f.path)}`),
    ...(s.files.length > show ? [`  ... and ${s.files.length - show} more (--json lists them all)`] : []),
  ];
  if (s.skipped.length) {
    lines.push(`Skipped ${s.skipped.length}, never shown to the model:`);
    for (const k of s.skipped.slice(0, show)) lines.push(`  ${safe(k.path)}  ${safe(k.reason)}`);
    if (s.skipped.length > show) lines.push(`  ... and ${s.skipped.length - show} more`);
  }
  return lines.join("\n");
}

const json = (contact: string, s: Share) => ({ contact, repo: s.repo, commit: s.commit, hash: s.hash, files: s.files.map((f) => ({ path: f.path, blob: f.blob, bytes: Buffer.byteLength(f.text) })), skipped: s.skipped });

export async function shareCommand(node: Counterpart, home: string, args: string[], o: Opts): Promise<{ human: string; data: unknown }> {
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
    return { human: `Removed ${n} rule${n === 1 ? "" : "s"}. ${left ? `Your front desk for ${c.name} can still read ${left.files.length} file(s). See: cpart share list ${c.name}` : `Nothing from a repository is shared with ${c.name} now.`}`, data: { removed: n, left: left ? json(c.name, left) : null } };
  }
  if (!args[0]) throw new Error(`usage:\n${SHARE_USAGE}`);
  const c = node.contact(args[0]);
  const patterns = args.slice(1);
  const existing = shareRules(home, c.rootKey);
  const repo = o.repo ?? existing[0]?.repo;
  if (!repo) throw new Error("give the repository: cpart share <contact> --repo <path> <path or glob>...");
  if (patterns.length === 0 && !o.allow?.length) throw new Error("name the files to share, relative to the repository root, like docs/api.md or \"src/**/*.ts\"");
  const plan = planShare(home, c.rootKey, repo, patterns, o.allow ?? []);
  const all = [...existing.filter((r) => !plan.rows.some((x) => x.kind === r.kind && x.pattern === r.pattern)), ...plan.rows];
  const shown = (rules: ShareRule[]): string[] => rules.map((r) => (r.kind === "allow" ? `${r.pattern} (allowed)` : r.pattern));
  // Shown before the owner says yes, so they see every file, not only the rules.
  o.gate.print(
    [
      describe(c.name, plan.share, shown(all), o.safe, Infinity),
      "",
      `${c.name} is someone else. Their agent can ask for anything in these files, and the front desk may quote it.`,
      "Each time it answers, the front desk reads these again from the latest commit, so a directory or glob also covers files you commit there later.",
      "",
    ].join("\n"),
  );
  await confirm(node, o.gate);
  const s = saveShare(home, c.rootKey, plan);
  const rules = shareRules(home, c.rootKey);
  const human = `${describe(c.name, s, shown(rules), o.safe)}
Each time it answers, the front desk reads these again from the latest commit. Uncommitted changes are never read.
Every line it sends must quote one of these files, and code checks the quote. Turn it on with: cpart desk on ${c.name}`;
  return { human, data: { ...json(c.name, s), rules } };
}

// Sharing files with someone else must come from the owner, not from an agent
// that can run cpart in their shell. Like approve: a typed word in a terminal,
// and the passphrase when the identity has one. Scripts pass --yes and set
// CPART_PASSPHRASE, which only works for an identity with a passphrase.
export interface Gate {
  tty: boolean;
  yes: boolean;
  envPassphrase: boolean; // CPART_PASSPHRASE is set
  print: (s: string) => void;
  line: (prompt: string) => Promise<string>;
  secret: (prompt: string) => Promise<string>;
}

async function confirm(node: Counterpart, g: Gate): Promise<void> {
  if (g.yes) {
    if (!node.protected || !g.envPassphrase) throw new Error("--yes is only for scripts that set CPART_PASSPHRASE on an identity with a passphrase. Nothing was shared.");
  } else {
    if (!g.tty) throw new Error("sharing files needs you, not your agent: run this in a terminal. Nothing was shared.");
    if ((await g.line("Type share to let the front desk read these files: ")) !== "share") throw new Error("nothing was shared.");
  }
  if (node.protected) {
    try {
      node.checkPassphrase(await g.secret("Passphrase: "));
    } catch (e) {
      throw new Error(`${(e as Error).message}. Nothing was shared.`);
    }
  }
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
