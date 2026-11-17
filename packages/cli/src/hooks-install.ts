// Claude Code hooks for Counterpart, installed as a local plugin. The plugin
// lives in $CPART_HOME/claude-plugin and holds nothing but hooks/hooks.json.
// `claude plugin install` adds it, so Claude Code's own code edits its
// settings; we never write them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_MAIN = join(dirname(fileURLToPath(import.meta.resolve("@counterpart/mcp"))), "hook-main.ts");
const MARKET = "counterpart-local";
const PLUGIN = "counterpart";
const ID = `${PLUGIN}@${MARKET}`;
const VERSION = "0.2.0";

export const pluginRoot = (home: string): string => join(resolve(home), "claude-plugin");
const pluginDir = (home: string): string => join(pluginRoot(home), PLUGIN);

// For a shell: Claude Code runs a hook's command line with sh.
const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function hooksConfig(home: string): object {
  const cmd = (event: string): string => `CPART_HOME=${sh(resolve(home))} ${sh(process.execPath)} ${sh(HOOK_MAIN)} ${event}`;
  return {
    description: "Counterpart: tell this session when a contact's side adds something to a thread it used (never what), and keep it on a thread it follows until the contact replies.",
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd("prompt"), timeout: 10 }] }],
      PostToolUse: [
        {
          matcher: "mcp__.*__counterpart_.*",
          hooks: [
            { type: "command", command: cmd("tool"), timeout: 15 },
            // In the background; exits 2 with a notice when something arrives,
            // which wakes the session even when it is idle.
            { type: "command", command: cmd("watch"), asyncRewake: true, timeout: 1800 },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: cmd("stop"), timeout: 15 }] }],
    },
  };
}

// The version names the content, so a changed command (a moved checkout, a
// new Node) is picked up by `claude plugin update`.
function writePlugin(home: string): string {
  const hooks = `${JSON.stringify(hooksConfig(home), null, 2)}\n`;
  const version = `${VERSION}-h${createHash("sha256").update(hooks).digest("hex").slice(0, 10)}`;
  const root = pluginRoot(home);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(pluginDir(home), ".claude-plugin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(pluginDir(home), "hooks"), { recursive: true, mode: 0o700 });
  const about = "Hooks that tell a Claude Code session when a Counterpart contact replies";
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), `${JSON.stringify({ name: MARKET, owner: { name: "Counterpart" }, description: about, plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, description: about }] }, null, 2)}\n`);
  writeFileSync(join(pluginDir(home), ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: PLUGIN, version, description: about, author: { name: "Counterpart" } }, null, 2)}\n`);
  writeFileSync(join(pluginDir(home), "hooks", "hooks.json"), hooks);
  return version;
}

export interface HooksState {
  found: boolean;
  // here: installed from this home's plugin. elsewhere: a plugin with this id
  // from somewhere else (another identity or checkout). no: not installed.
  state: "here" | "elsewhere" | "no";
  enabled?: boolean;
  version?: string;
}

const claude = (args: string[]) => spawnSync("claude", args, { encoding: "utf8", timeout: 60_000 });

export function claudeHooks(home: string): HooksState {
  if (claude(["--version"]).status !== 0) return { found: false, state: "no" };
  const r = claude(["plugin", "list", "--json"]);
  if (r.status !== 0) return { found: true, state: "no" };
  let list: { id?: string; scope?: string; enabled?: boolean; version?: string; readFromFolder?: string }[] = [];
  try {
    list = JSON.parse(r.stdout) as typeof list;
  } catch {
    return { found: true, state: "no" };
  }
  const p = list.find((x) => x.id === ID && x.scope === "user");
  if (!p) return { found: true, state: "no" };
  const mine = p.readFromFolder !== undefined && resolve(p.readFromFolder) === pluginDir(home);
  return { found: true, state: mine ? "here" : "elsewhere", ...(p.enabled !== undefined ? { enabled: p.enabled } : {}), ...(p.version ? { version: p.version } : {}) };
}

export interface HooksResult extends HooksState {
  changed: "installed" | "updated" | "removed" | "none";
  error?: string;
}

const firstLine = (r: ReturnType<typeof claude>): string => (r.stderr || r.stdout || "failed").trim().split("\n")[0]!;

export function installClaudeHooks(home: string): HooksResult {
  const before = claudeHooks(home);
  if (!before.found || before.state === "elsewhere") return { ...before, changed: "none" };
  const version = writePlugin(home);
  if (before.state === "here") {
    if (before.version === version) return { ...before, changed: "none" };
    claude(["plugin", "marketplace", "update", MARKET]);
    const r = claude(["plugin", "update", ID, "--scope", "user"]);
    if (r.status !== 0) return { ...before, changed: "none", error: firstLine(r) };
    return { ...claudeHooks(home), changed: "updated" };
  }
  const r = claude(["plugin", "install", PLUGIN, "--marketplace", pluginRoot(home), "--scope", "user"]);
  if (r.status !== 0) return { ...before, changed: "none", error: firstLine(r) };
  return { ...claudeHooks(home), changed: "installed" };
}

export function removeClaudeHooks(home: string): HooksResult {
  const before = claudeHooks(home);
  if (before.state !== "here") return { ...before, changed: "none" };
  const r = claude(["plugin", "uninstall", ID, "--scope", "user"]);
  if (r.status !== 0) return { ...before, changed: "none", error: firstLine(r) };
  claude(["plugin", "marketplace", "remove", MARKET]);
  rmSync(pluginRoot(home), { recursive: true, force: true });
  return { ...claudeHooks(home), changed: "removed" };
}

// ---- both, for cpart setup and cpart hook install|remove

export interface BothHooks {
  claude: HooksResult;
  codex: HooksResult & { file: string };
}

export const installHooks = (home: string): BothHooks => ({ claude: installClaudeHooks(home), codex: installCodexHooks(home) });
export const removeHooks = (home: string): BothHooks => ({ claude: removeClaudeHooks(home), codex: removeCodexHooks(home) });

// One line each, as `cpart setup` prints them. `safe` escapes text from elsewhere.
export function hookLines(r: BothHooks, safe: (s: string) => string): string[] {
  const out: string[] = [];
  const c = r.claude;
  if (c.found)
    out.push(
      c.error ? `--  Claude Code hooks: ${c.state === "here" ? "could not update them" : "could not add them"} (${safe(c.error)})`
      : c.state === "elsewhere" ? `--  Claude Code already has a plugin named ${ID} from another identity or checkout. It was left alone. To switch: claude plugin uninstall ${ID}, then cpart setup`
      : c.state === "here" ? `ok  Claude Code ${c.changed === "none" ? "already has" : c.changed === "updated" ? "has updated" : "now has"} the hooks that tell a session when a reply arrives${c.enabled === false ? ", but the plugin is disabled" : ""}${c.changed === "none" ? "" : ". Sessions started from now on use them"}`
      : c.changed === "removed" ? "ok  Claude Code hooks removed"
      : "--  Claude Code has no Counterpart hooks",
    );
  const x = r.codex;
  if (x.found)
    out.push(
      x.error ? `--  Codex hooks: could not change ${safe(x.file)} (${safe(x.error)})`
      : x.state === "here" ? `ok  Codex ${x.changed === "none" ? "already has" : x.changed === "updated" ? "has updated" : "now has"} the hooks in ${safe(x.file)}${x.changed === "none" ? "" : ". Codex runs them only once you trust them: start codex, type /hooks, and trust the three Counterpart hooks"}`
      : x.changed === "removed" ? `ok  Codex hooks removed from ${safe(x.file)}`
      : "--  Codex has no Counterpart hooks",
    );
  return out;
}

// ---- Codex
//
// Codex reads hooks from $CODEX_HOME/hooks.json and runs them only after the
// person has trusted them in Codex (/hooks), against their hash. It has no way
// to wake an idle session, so there is no watch. Its hook input and output
// for these three events are the ones Claude Code uses.

const codexFile = (): string => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "hooks.json");

type Group = { matcher?: string; hooks?: { command?: unknown }[] };
type CodexHooks = { hooks?: Record<string, Group[]> } & Record<string, unknown>;

export function codexHooksConfig(home: string): Record<string, Group[]> {
  const all = hooksConfig(home) as { hooks: Record<string, Group[]> };
  return {
    UserPromptSubmit: all.hooks.UserPromptSubmit!,
    PostToolUse: all.hooks.PostToolUse!.map((g) => ({ ...g, hooks: g.hooks!.filter((h) => !String(h.command).endsWith(" watch")) })),
    Stop: all.hooks.Stop!,
  };
}

// A hook is ours when its command runs our hook entry for this home.
const mine = (home: string, h: { command?: unknown }): boolean => typeof h.command === "string" && h.command.startsWith(`CPART_HOME=${sh(resolve(home))} `) && h.command.includes("hook-main.ts");
const ours =
  (home: string) =>
  (g: Group): boolean =>
    (g.hooks ?? []).some((h) => mine(home, h));
// The same groups without our hooks. A group left with none is dropped;
// anything else in a group, someone else's hook or a field, stays.
const without = (home: string, groups: Group[]): Group[] =>
  groups.flatMap((g) => (!ours(home)(g) ? [g] : (g.hooks ?? []).every((h) => mine(home, h)) ? [] : [{ ...g, hooks: g.hooks!.filter((h) => !mine(home, h)) }]));

function readCodex(): CodexHooks {
  if (!existsSync(codexFile())) return {};
  const j = JSON.parse(readFileSync(codexFile(), "utf8")) as unknown;
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(`${codexFile()} is not a JSON object`);
  return j as CodexHooks;
}

function writeCodex(j: CodexHooks): void {
  mkdirSync(dirname(codexFile()), { recursive: true });
  const tmp = `${codexFile()}.cpart-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(j, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, codexFile());
}

const codexFound = (): boolean => spawnSync("codex", ["--version"], { stdio: "ignore", timeout: 30_000 }).status === 0;

export function codexHooks(home: string): HooksState & { file: string } {
  if (!codexFound()) return { found: false, state: "no", file: codexFile() };
  try {
    const j = readCodex();
    const want = codexHooksConfig(home);
    const have = Object.keys(want).every((ev) => (j.hooks?.[ev] ?? []).some(ours(home)));
    const same = Object.entries(want).every(([ev, groups]) => JSON.stringify((j.hooks?.[ev] ?? []).filter(ours(home))) === JSON.stringify(groups));
    return { found: true, state: have ? "here" : "no", ...(have ? { version: same ? "current" : "old" } : {}), file: codexFile() };
  } catch {
    return { found: true, state: "no", file: codexFile() };
  }
}

// Adds our entries to hooks.json, replacing older ones for this home and
// keeping everything else. A file that does not parse is left alone.
export function installCodexHooks(home: string): HooksResult & { file: string } {
  const before = codexHooks(home);
  if (!before.found) return { ...before, changed: "none" };
  if (before.state === "here" && before.version === "current") return { ...before, changed: "none" };
  try {
    const j = readCodex();
    const hooks: Record<string, Group[]> = { ...(j.hooks ?? {}) };
    for (const [ev, groups] of Object.entries(codexHooksConfig(home))) hooks[ev] = [...without(home, hooks[ev] ?? []), ...groups];
    writeCodex({ ...j, hooks });
  } catch (e) {
    return { ...before, changed: "none", error: (e as Error).message };
  }
  return { ...codexHooks(home), changed: before.state === "here" ? "updated" : "installed" };
}

export function removeCodexHooks(home: string): HooksResult & { file: string } {
  const before = codexHooks(home);
  if (!before.found) return { ...before, changed: "none" };
  try {
    const j = readCodex();
    // Any of ours goes, even when someone took out the rest by hand.
    if (!Object.values(j.hooks ?? {}).some((groups) => groups.some(ours(home)))) return { ...before, changed: "none" };
    const hooks: Record<string, Group[]> = {};
    for (const [ev, groups] of Object.entries(j.hooks ?? {})) {
      const left = without(home, groups);
      if (left.length) hooks[ev] = left;
    }
    writeCodex({ ...j, hooks });
  } catch (e) {
    return { ...before, changed: "none", error: (e as Error).message };
  }
  return { ...codexHooks(home), changed: "removed" };
}
