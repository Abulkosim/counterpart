// Claude Code hooks for Counterpart, installed as a local plugin. The plugin
// lives in $CPART_HOME/claude-plugin and holds nothing but hooks/hooks.json.
// `claude plugin install` adds it, so Claude Code's own code edits its
// settings; we never write them.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
