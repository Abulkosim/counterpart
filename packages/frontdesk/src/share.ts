import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git, sensitive } from "@counterpart/worker";
import { findSecret } from "./secrets.ts";

// A share lets the front desk read files from the owner's own repository for
// one contact. The owner names paths or globs; at every run the desk reads the
// files they match from the commit HEAD points to, through Git's object store.
// The working tree is never read, so uncommitted edits, untracked files and
// ignored files are never seen. A committed file that matches an ignore rule
// committed in the same commit is left out too. Each file is checked before the model can see it: paths the
// worker treats as sensitive are refused, credential files always, and content
// that looks like a secret is skipped and reported.

export interface ShareRule {
  repo: string;
  pattern: string;
  kind: "path" | "allow"; // "allow": a sensitive path the owner let through by name
}
export interface SharedFile {
  path: string; // relative to the repository root
  text: string;
  blob: string; // Git's id for these bytes
}
export interface Skipped {
  path: string;
  reason: string;
}
export interface Share {
  repo: string;
  commit: string;
  files: SharedFile[];
  skipped: Skipped[];
  bytes: number;
  hash: string; // identifies exactly what was readable: the commit and every file
  rulesHash: string; // identifies what the owner said; changes only when they change it
}

export const SHARE_LIMITS = { files: 2000, bytes: 16 * 1024 * 1024, fileBytes: 256 * 1024, patterns: 200 } as const;

// Paths never shown, even when named. The worker's list is about what runs;
// these are about what is private.
const PRIVATE: [RegExp, string][] = [
  [/(^|\/)\.(ssh|gnupg|aws|azure|kube|docker)\//, "credentials"],
  [/(^|\/)(kubeconfig|\.htpasswd|\.pgpass|\.git-credentials|\.npmrc|\.pypirc)$/, "credentials"],
  [/\.(p12|pfx|jks|keystore|kdbx|gpg|tfstate|tfvars)$/, "credentials"],
  // A file or any directory above it: config/secrets/db.yml as well as secret.txt.
  [/(^|\/)([^/]*secret[^/]*|vaults?|\.?credentials?)(\/|$)/, "named as a secret"],
];
const NEVER = new Set(["credentials"]);

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function db(home: string): DatabaseSync {
  const d = new DatabaseSync(join(home, "frontdesk.db"));
  d.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS shares (
      contact_root TEXT NOT NULL, repo TEXT NOT NULL, pattern TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (contact_root, pattern, kind)
    );
  `);
  return d;
}

export function shareRules(home: string, contactRoot: string): ShareRule[] {
  const d = db(home);
  try {
    return (d.prepare("SELECT repo, pattern, kind FROM shares WHERE contact_root = ? ORDER BY kind, pattern").all(contactRoot) as unknown as ShareRule[]).map((r) => ({ ...r }));
  } finally {
    d.close();
  }
}

// A pattern is relative to the repository root: a file, a directory, or a glob
// with *, ** and ?. It is matched by this code against committed paths, never
// handed to Git or a shell.
export function checkPattern(p: string): string {
  const t = p.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!t || t.length > 300 || t.startsWith("/") || /[\\\0-\x1f\x7f]/.test(t) || /^[!:]/.test(t) || t.split("/").some((s) => s === ".." || s === "." || s === ""))
    throw new Error(`"${p}": give a path inside the repository, relative to its root, like docs/api.md or "src/**/*.ts"`);
  return t;
}

export function globToRegExp(pattern: string): RegExp {
  if (!/[*?]/.test(pattern)) {
    const e = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${e}(/.*)?$`); // a file, or everything under a directory
  }
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function repoRoot(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`${path} does not exist`);
  }
  if (!lstatSync(real).isDirectory()) throw new Error(`${path} is not a directory`);
  let top: string;
  try {
    top = git(real, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  } catch {
    throw new Error(`${path} is not inside a Git repository with a working tree`);
  }
  return realpathSync(top);
}

// Add patterns (and sensitive paths allowed by name) for a contact. One
// repository per contact. Returns what would be shared right now.
export function addShare(home: string, contactRoot: string, repoPath: string, patterns: string[], allow: string[] = []): Share {
  return saveShare(home, contactRoot, planShare(home, contactRoot, repoPath, patterns, allow));
}

// What adding these rules would share, checked but not saved, so the owner can
// see it before saying yes.
export interface SharePlan {
  repo: string;
  rows: ShareRule[];
  share: Share;
}

export function planShare(home: string, contactRoot: string, repoPath: string, patterns: string[], allow: string[] = []): SharePlan {
  if (patterns.length === 0 && allow.length === 0) throw new Error("name at least one path or glob to share");
  const repo = repoRoot(repoPath);
  const current = shareRules(home, contactRoot);
  if (current.length && current[0]!.repo !== repo) throw new Error(`this contact already has files shared from ${current[0]!.repo}. One repository per contact: remove those first with cpart share remove <contact> --all`);
  const rows: ShareRule[] = [...patterns.map((p) => ({ repo, pattern: checkPattern(p), kind: "path" as const })), ...allow.map((p) => ({ repo, pattern: checkPattern(p), kind: "allow" as const }))];
  for (const r of rows) if (r.kind === "allow" && /[*?]/.test(r.pattern)) throw new Error(`"${r.pattern}": a sensitive path is allowed by its exact name, not a glob`);
  if (new Set([...current, ...rows].map((r) => `${r.kind}\0${r.pattern}`)).size > SHARE_LIMITS.patterns) throw new Error(`at most ${SHARE_LIMITS.patterns} patterns per contact`);
  // Read before saving, so a mistake shows now and not when the contact asks.
  const preview = readShareFrom(repo, [...current, ...rows]);
  for (const r of rows.filter((x) => x.kind === "path")) {
    const re = globToRegExp(r.pattern);
    if (!preview.all.some((p) => re.test(p))) throw new Error(`"${r.pattern}" matches nothing committed at HEAD (${preview.share.commit.slice(0, 12)}). Only committed files can be shared; commit it first. Nothing was changed.`);
  }
  return { repo, rows, share: preview.share };
}

export function saveShare(home: string, contactRoot: string, plan: SharePlan): Share {
  const { repo, rows } = plan;
  const d = db(home);
  try {
    // Checked again inside the write, so two commands run at once cannot
    // leave rules for two repositories.
    d.exec("BEGIN IMMEDIATE");
    try {
      const other = d.prepare("SELECT repo FROM shares WHERE contact_root = ? AND repo != ? LIMIT 1").get(contactRoot, repo) as { repo: string } | undefined;
      if (other) throw new Error(`this contact already has files shared from ${other.repo}. One repository per contact: remove those first with cpart share remove <contact> --all`);
      const ins = d.prepare("INSERT OR REPLACE INTO shares (contact_root, repo, pattern, kind, at) VALUES (?, ?, ?, ?, ?)");
      for (const r of rows) ins.run(contactRoot, repo, r.pattern, r.kind, Date.now());
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  } finally {
    d.close();
  }
  return plan.share;
}

// Remove patterns, or every rule for the contact when `patterns` is "all".
// Returns how many rules were removed.
export function removeShare(home: string, contactRoot: string, patterns: string[] | "all"): number {
  const d = db(home);
  try {
    if (patterns === "all") return Number(d.prepare("DELETE FROM shares WHERE contact_root = ?").run(contactRoot).changes);
    let n = 0;
    for (const p of patterns) n += Number(d.prepare("DELETE FROM shares WHERE contact_root = ? AND pattern = ?").run(contactRoot, p.replace(/^(\.\/)+/, "").replace(/\/+$/, "")).changes);
    if (n === 0) throw new Error(`nothing shared under ${patterns.map((p) => `"${p}"`).join(", ")}. See: cpart share list <contact>`);
    return n;
  } finally {
    d.close();
  }
}

// What the contact's front desk can read right now, or null if nothing is shared.
export function readShare(home: string, contactRoot: string): Share | null {
  const rules = shareRules(home, contactRoot);
  if (rules.length === 0) return null;
  if (new Set(rules.map((r) => r.repo)).size > 1) throw new Error("the share rules for this contact name more than one repository; run cpart share remove <contact> --all and share again");
  return readShareFrom(rules[0]!.repo, rules).share;
}

export function rulesHash(rules: ShareRule[]): string {
  return sha(JSON.stringify(rules.map((r) => [r.repo, r.kind, r.pattern]).sort()));
}

// Blob contents are addressed by their own hash, so a cache keyed on it can
// never hand back the wrong bytes. It saves re-reading and re-scanning files
// that did not change between runs.
const blobCache = new Map<string, { text: string } | { reason: string }>();
let cachedBytes = 0;

// Read blobs by id from the object store, in one Git process.
function readBlobs(repo: string, ids: string[]): Map<string, Buffer> {
  const got = new Map<string, Buffer>();
  if (ids.length === 0) return got;
  const out = git(repo, ["cat-file", "--batch"], { input: ids.join("\n") + "\n", maxBuffer: SHARE_LIMITS.bytes + 4 * 1024 * 1024 });
  let at = 0;
  for (const want of ids) {
    const nl = out.indexOf(10, at);
    const [id, type, size] = out.subarray(at, nl).toString("utf8").split(" ") as [string, string, string];
    if (nl < 0 || id !== want || type !== "blob") throw new Error("git returned something other than the requested file");
    got.set(want, out.subarray(nl + 1, nl + 1 + Number(size)));
    at = nl + 1 + Number(size) + 1;
  }
  return got;
}

// Which of `paths` the ignore rules committed at this commit cover, plus the
// repository's own info/exclude. The .gitignore files are copied out of the
// commit into an empty directory and Git is pointed at that, so edits to the
// working tree or the index change nothing. If this cannot be done, nothing is
// shared: an error is thrown rather than skipping the check.
function ignoredAt(repo: string, tree: { mode: string; type: string; blob: string; path: string }[], paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]).toString("utf8").trim();
  const rules = tree.filter((e) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755") && (e.path === ".gitignore" || e.path.endsWith("/.gitignore")) && !e.path.split("/").some((s) => s === ".." || s === "." || s === ""));
  const blobs = readBlobs(repo, [...new Set(rules.map((e) => e.blob))]);
  const work = mkdtempSync(join(tmpdir(), "cpart-ignore-"));
  try {
    for (const e of rules) {
      mkdirSync(dirname(join(work, e.path)), { recursive: true });
      writeFileSync(join(work, e.path), blobs.get(e.blob)!);
    }
    let out: string;
    try {
      out = git(work, ["--git-dir", gitDir, "--work-tree", work, "check-ignore", "--no-index", "-z", "--stdin"], { input: paths.join("\0") + "\0", maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
    } catch (e) {
      // Exit status 1 means none of the paths is ignored.
      if ((e as { status?: number }).status === 1) return new Set();
      throw new Error(`could not check the repository's ignore rules: ${String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).slice(0, 200)}`);
    }
    return new Set(out.split("\0").filter(Boolean));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function readShareFrom(repo: string, rules: ShareRule[]): { share: Share; all: string[] } {
  let commit: string;
  try {
    commit = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim();
  } catch {
    throw new Error(`${repo} has no commit at HEAD`);
  }
  const tree = git(repo, ["ls-tree", "-r", "-z", "-l", "--full-tree", commit], { maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, blob, size] = line.slice(0, tab).split(/ +/) as [string, string, string, string];
      return { mode, type, blob, size: Number(size), path: line.slice(tab + 1) };
    });
  const paths = rules.filter((r) => r.kind === "path").map((r) => globToRegExp(r.pattern));
  const allowed = new Set(rules.filter((r) => r.kind === "allow").map((r) => r.pattern));
  // Committed files that an ignore rule covers were most likely added by mistake.
  const ignored = ignoredAt(repo, tree, tree.filter((e) => paths.some((re) => re.test(e.path)) || allowed.has(e.path)).map((e) => e.path));
  const skipped: Skipped[] = [];
  const wanted: typeof tree = [];
  for (const e of tree) {
    if (!paths.some((re) => re.test(e.path)) && !allowed.has(e.path)) continue;
    // Every rule that applies is looked at, so a path that is both
    // credentials and something else is still never shared.
    const kinds = [...PRIVATE.filter(([re]) => re.test(e.path.toLowerCase())).map(([, what]) => what), sensitive(e.path)].filter((k): k is string => !!k);
    const sens = kinds.find((k) => NEVER.has(k)) ?? kinds[0];
    if (e.type !== "blob") skipped.push({ path: e.path, reason: "a submodule" });
    else if (e.mode === "120000") skipped.push({ path: e.path, reason: "a symbolic link" });
    else if (e.mode !== "100644" && e.mode !== "100755") skipped.push({ path: e.path, reason: "not a regular file" });
    else if (ignored.has(e.path)) skipped.push({ path: e.path, reason: "matched by an ignore rule" });
    else if (sens && NEVER.has(sens)) skipped.push({ path: e.path, reason: `${sens}; never shared` });
    else if (sens && !allowed.has(e.path)) skipped.push({ path: e.path, reason: `${sens}; share it with --allow ${e.path}` });
    else if (e.size > SHARE_LIMITS.fileBytes) skipped.push({ path: e.path, reason: `larger than ${SHARE_LIMITS.fileBytes / 1024} KB` });
    else wanted.push(e);
  }
  let total = 0;
  const take: typeof tree = [];
  for (const e of wanted) {
    if (take.length >= SHARE_LIMITS.files || total + e.size > SHARE_LIMITS.bytes) skipped.push({ path: e.path, reason: "over the share limit" });
    else {
      take.push(e);
      total += e.size;
    }
  }
  // What this read needs is kept here, so clearing the cache part way
  // through cannot lose an entry.
  const mine = new Map<string, { text: string } | { reason: string }>();
  for (const e of take) {
    const c = blobCache.get(e.blob);
    if (c) mine.set(e.blob, c);
  }
  const loaded = readBlobs(repo, [...new Set(take.map((e) => e.blob).filter((b) => !mine.has(b)))]);
  if (cachedBytes > 64 * 1024 * 1024) {
    blobCache.clear();
    cachedBytes = 0;
  }
  for (const [id, bytes] of loaded) {
    let entry: { text: string } | { reason: string };
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error();
      const hit = findSecret(text);
      entry = hit ? { reason: `looks like it holds ${hit.what} (line ${hit.line})` } : { text };
    } catch {
      entry = { reason: "not UTF-8 text" };
    }
    mine.set(id, entry);
    blobCache.set(id, entry);
    cachedBytes += bytes.length;
  }
  const files: SharedFile[] = [];
  for (const e of take) {
    const c = mine.get(e.blob)!;
    if ("reason" in c) skipped.push({ path: e.path, reason: c.reason });
    else files.push({ path: e.path, text: c.text, blob: e.blob });
  }
  skipped.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    share: {
      repo, commit, files, skipped,
      bytes: files.reduce((n, f) => n + Buffer.byteLength(f.text), 0),
      hash: sha(`${commit}\n${files.map((f) => `${f.path}\0${f.blob}\n`).join("")}`),
      rulesHash: rulesHash(rules),
    },
    all: tree.map((e) => e.path),
  };
}
