// Keeping the daemon running without a terminal, and telling coding agents
// where the MCP server is. Nothing here touches keys or messages.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), "main.ts");
export const DEFAULT_HOME = join(homedir(), ".counterpart");

export interface DaemonState {
  pid: number;
  startedAt: number;
  connected: boolean;
  relay: string;
}

const stateFile = (home: string): string => join(home, "daemon.json");
export const logFile = (home: string): string => join(home, "daemon.log");

// One home, one daemon: two would both answer the relay and both run the
// front desk. The daemon holds an exclusive SQLite lock on a file of its own
// for as long as it lives. The operating system drops the lock when the
// process ends, however it ends, so a pid that was reused cannot look like a
// daemon, and two daemons started at the same moment cannot both win.
const lockFile = (home: string): string => join(home, "daemon.lock");

function takeLock(home: string): DatabaseSync | undefined {
  const db = new DatabaseSync(lockFile(home));
  try {
    db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS held (x); COMMIT; BEGIN EXCLUSIVE");
    return db;
  } catch (e) {
    db.close();
    if (/locked|busy/i.test((e as Error).message)) return undefined;
    throw e;
  }
}

// The daemon that holds this home, if one is running.
export function running(home: string): DaemonState | undefined {
  if (!existsSync(lockFile(home))) return undefined;
  const free = takeLock(home);
  if (free) {
    free.close();
    return undefined;
  }
  try {
    const s = JSON.parse(readFileSync(stateFile(home), "utf8")) as DaemonState;
    if (Number.isInteger(s.pid)) return s;
  } catch {
    // The holder has the lock and has not written its state yet.
  }
  return { pid: 0, startedAt: Date.now(), connected: false, relay: "" };
}

// Called by `cpart daemon` itself.
export function claim(home: string, relay: string): { set(connected: boolean): void; release(): void } {
  const lock = takeLock(home);
  if (!lock) throw new Error(`a daemon is already running for ${home}${running(home)?.pid ? ` (pid ${running(home)!.pid})` : ""}. Stop it with: cpart down`);
  const state: DaemonState = { pid: process.pid, startedAt: Date.now(), connected: false, relay };
  // Written whole or not at all, so a reader never sees half a file.
  const write = (): void => {
    writeFileSync(`${stateFile(home)}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${stateFile(home)}.tmp`, stateFile(home));
  };
  write();
  return {
    set(connected) {
      state.connected = connected;
      write();
    },
    release() {
      rmSync(stateFile(home), { force: true });
      lock.close();
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(ms: number, f: () => T | undefined): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined || Date.now() > end) return v;
    await sleep(100);
  }
}

// ---- starting at login

const unitName = (home: string): string => (resolve(home) === DEFAULT_HOME ? "cpart" : `cpart-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 8)}`);
const systemdUnit = (home: string): string => join(homedir(), ".config/systemd/user", `${unitName(home)}.service`);
const launchdLabel = (home: string): string => `dev.counterpart.${unitName(home)}`;
const launchdPlist = (home: string): string => join(homedir(), "Library/LaunchAgents", `${launchdLabel(home)}.plist`);
const run = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;

export type Boot = "systemd" | "launchd";

export function bootKind(): Boot | undefined {
  if (process.env.CPART_NO_BOOT === "1") return undefined;
  if (platform() === "linux" && run("systemctl", ["--user", "show-environment"])) return "systemd";
  if (platform() === "darwin") return "launchd";
  return undefined;
}

export function bootInstalled(home: string): Boot | undefined {
  if (existsSync(systemdUnit(home))) return "systemd";
  if (existsSync(launchdPlist(home))) return "launchd";
  return undefined;
}

// The daemon starts the `claude` CLI for the front desk, so it needs the PATH
// this shell has, and the CLAUDE_CONFIG_DIR if one is set, or claude would
// look for its login somewhere else. A login service would otherwise get a
// bare environment.
// systemd splits on spaces and expands % everywhere in a unit file.
const quote = (s: string): string => `"${s.replace(/["\\]/g, "\\$&").replace(/%/g, "%%")}"`;

function installBoot(home: string, kind: Boot): void {
  const env: Record<string, string> = { CPART_HOME: resolve(home), PATH: process.env.PATH ?? "" };
  if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = resolve(process.env.CLAUDE_CONFIG_DIR);
  if (kind === "systemd") {
    mkdirSync(dirname(systemdUnit(home)), { recursive: true });
    writeFileSync(
      systemdUnit(home),
      [
        "[Unit]",
        "Description=Counterpart daemon",
        "After=network-online.target",
        "",
        "[Service]",
        `ExecStart=${[process.execPath, MAIN, "daemon"].map((a) => quote(a).replace(/\$/g, "$$$$")).join(" ")}`,
        ...Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`),
        "Restart=always",
        "RestartSec=5",
        `StandardOutput=append:${resolve(logFile(home)).replace(/%/g, "%%")}`,
        `StandardError=append:${resolve(logFile(home)).replace(/%/g, "%%")}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    run("systemctl", ["--user", "daemon-reload"]);
    if (!run("systemctl", ["--user", "enable", "--now", unitName(home)])) throw new Error(`systemd would not start ${unitName(home)}. See: systemctl --user status ${unitName(home)}`);
    return;
  }
  const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  mkdirSync(dirname(launchdPlist(home)), { recursive: true });
  writeFileSync(
    launchdPlist(home),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${launchdLabel(home)}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(MAIN)}</string><string>daemon</string></array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(resolve(logFile(home)))}</string>
  <key>StandardErrorPath</key><string>${xml(resolve(logFile(home)))}</string>
</dict></plist>
`,
  );
  if (!run("launchctl", ["load", "-w", launchdPlist(home)])) throw new Error(`launchd would not load ${launchdPlist(home)}`);
}

function removeBoot(home: string): void {
  if (existsSync(systemdUnit(home))) {
    run("systemctl", ["--user", "disable", "--now", unitName(home)]);
    rmSync(systemdUnit(home));
    run("systemctl", ["--user", "daemon-reload"]);
  }
  if (existsSync(launchdPlist(home))) {
    run("launchctl", ["unload", "-w", launchdPlist(home)]);
    rmSync(launchdPlist(home));
  }
}

// ---- up and down

export interface UpResult {
  state: DaemonState | undefined;
  started: boolean;
  boot: Boot | undefined;
}

// Start the daemon in the background unless it is already running. With
// boot, also have the system start it at login and restart it if it dies.
export async function up(home: string, opts: { boot?: boolean } = {}): Promise<UpResult> {
  const before = running(home);
  let boot = bootInstalled(home);
  let installed = false;
  if (opts.boot && !boot) {
    const kind = bootKind();
    if (kind) {
      if (before) await down(home, { keepBoot: true });
      // Installing also starts it.
      installBoot(home, kind);
      boot = kind;
      installed = true;
    }
  }
  if (!installed && !running(home)) {
    if (boot === "systemd") run("systemctl", ["--user", "start", unitName(home)]);
    else if (boot === "launchd") run("launchctl", ["load", "-w", launchdPlist(home)]);
    else {
      const log = openSync(logFile(home), "a", 0o600);
      spawn(process.execPath, [MAIN, "daemon"], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, CPART_HOME: resolve(home) } }).unref();
    }
  }
  await waitFor(8000, () => running(home));
  const state = await waitFor(5000, () => {
    const s = running(home);
    return s?.connected ? s : undefined;
  });
  const now = state ?? running(home);
  return { state: now?.pid ? now : undefined, started: !before, boot };
}

export async function down(home: string, opts: { keepBoot?: boolean } = {}): Promise<boolean> {
  const s = running(home);
  if (!opts.keepBoot) removeBoot(home);
  else if (bootInstalled(home) === "systemd") run("systemctl", ["--user", "stop", unitName(home)]);
  const now = running(home);
  if (now?.pid) {
    try {
      process.kill(now.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await waitFor(5000, () => (running(home) ? undefined : true));
  }
  return s !== undefined;
}

// ---- coding agents

export interface AgentHost {
  name: string;
  bin: string;
  found: boolean;
  // "here": set up for this identity. "elsewhere": a server named counterpart
  // exists but runs another program or another identity.
  registered: "here" | "elsewhere" | "no";
}

const HOSTS = [
  { name: "Claude Code", bin: "claude", add: ["mcp", "add", "--scope", "user"], get: ["mcp", "get", "counterpart"] },
  { name: "Codex", bin: "codex", add: ["mcp", "add"], get: ["mcp", "get", "counterpart", "--json"] },
] as const;

const has = (bin: string): boolean => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

export function agents(home: string): AgentHost[] {
  const mine = resolve(home);
  return HOSTS.map((h) => {
    if (!has(h.bin)) return { name: h.name, bin: h.bin, found: false, registered: "no" as const };
    const r = spawnSync(h.bin, [...h.get], { encoding: "utf8" });
    if (r.status !== 0) return { name: h.name, bin: h.bin, found: true, registered: "no" as const };
    // What the entry says about the home it uses. No CPART_HOME means the default.
    const text = r.stdout;
    const named = /CPART_HOME"?\s*[=:]\s*"?([^"\s,}]+)/.exec(text)?.[1];
    const sameHome = named === undefined ? mine === DEFAULT_HOME : named === mine || (/^\*+$/.test(named) && mine !== DEFAULT_HOME);
    return { name: h.name, bin: h.bin, found: true, registered: text.includes(MAIN) && sameHome ? ("here" as const) : ("elsewhere" as const) };
  });
}

// Add `cpart mcp` to every coding agent on this machine that has no server
// named counterpart. One that points somewhere else is reported, not replaced.
export function registerAgents(home: string): (AgentHost & { added: boolean; error?: string })[] {
  const env = resolve(home) === DEFAULT_HOME ? [] : ["--env", `CPART_HOME=${resolve(home)}`];
  return agents(home).map((a) => {
    if (!a.found || a.registered !== "no") return { ...a, added: false };
    const h = HOSTS.find((x) => x.bin === a.bin)!;
    const r = spawnSync(a.bin, [...h.add, "counterpart", ...env, "--", process.execPath, MAIN, "mcp"], { encoding: "utf8" });
    return r.status === 0 ? { ...a, registered: "here" as const, added: true } : { ...a, added: false, error: (r.stderr || r.stdout || "failed").trim().split("\n")[0]! };
  });
}
