import { execFileSync } from "node:child_process";

// Git, with what could run someone else's code switched off: no hooks, no
// external diff, no file monitor, no system or user configuration. Content
// filters cannot be switched off this way, so this module only ever asks Git
// to read committed objects (ls-tree, cat-file, rev-parse) or to diff two
// scratch directories. It never asks Git to read or write the working tree.
const HARDENED = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "diff.external=",
  "-c", "protocol.allow=never",
  "-c", "core.sshCommand=false",
  "-c", "credential.helper=",
];

export function git(cwd: string, args: string[], opts: { input?: string | Buffer; maxBuffer?: number } = {}): Buffer {
  // Replacement refs and grafts could make a commit id stand for other content,
  // and a partial clone could go to the network for a missing object.
  return execFileSync("git", ["--no-replace-objects", ...HARDENED, ...args], {
    timeout: 30_000,
    cwd,
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C" },
  });
}

export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

// Files committed at `commit` under `paths`. Read from the object store, not
// the working tree, so uncommitted or ignored files are never seen.
export function lsTree(repo: string, commit: string, paths: string[]): TreeEntry[] {
  const out = git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...paths]).toString("utf8");
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, sha] = line.slice(0, tab).split(" ") as [string, string, string];
      return { mode, type, sha, path: line.slice(tab + 1) };
    });
}

export const readBlob = (repo: string, sha: string): Buffer => git(repo, ["cat-file", "blob", sha]);
export const headCommit = (repo: string): string => git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim();

// Every committed path, for spotting a new file that differs from an existing
// one only by case, which is the same file on some filesystems.
export const allPaths = (repo: string, commit: string): string[] => git(repo, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
