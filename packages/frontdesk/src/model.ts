import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, release, tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface ModelRequest {
  system: string;
  prompt: string;
  // Overrides the adapter's own timeout for this call.
  timeoutMs?: number;
}
// A model here is text in, text out. It is given no tools; adapters must make
// sure of that themselves and refuse to run otherwise.
export type Model = (req: ModelRequest) => Promise<string>;

// A model call that failed. `short` is a fixed phrase chosen by code, never
// text the model or the other side wrote, so it can go on a status line.
export class ModelError extends Error {
  short: string;
  constructor(short: string, message = short) {
    super(message);
    this.short = short;
  }
}

// Where the model runs from, as the daemon sees it. Shown to the owner when a
// check fails: a daemon started at login has its own PATH and environment,
// not the shell's.
export type ModelSetup =
  | { kind: "claude-cli"; bin: string; found: string | null; path: string; configDir: string | null; defaultConfigDir: string }
  | { kind: "api"; baseUrl: string };

// The first executable file named `bin` on `path`, as spawn would find it.
function findOnPath(bin: string, path = process.env.PATH ?? ""): string | null {
  const candidates = isAbsolute(bin) || bin.includes("/") ? [bin] : path.split(delimiter).filter(Boolean).map((d) => join(d, bin));
  for (const c of candidates) {
    try {
      if (!statSync(c).isFile()) continue;
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* not here */
    }
  }
  return null;
}

export function claudeCliSetup(opts: { bin?: string } = {}): ModelSetup {
  const bin = opts.bin ?? "claude";
  const path = process.env.PATH ?? "";
  return { kind: "claude-cli", bin, found: findOnPath(bin, path), path, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, defaultConfigDir: join(homedir(), ".claude") };
}

const MAX_OUTPUT = 2 * 1024 * 1024;

export interface ClaudeCliOptions {
  model?: string;
  bin?: string;
  timeoutMs?: number;
}

// Runs Claude Code headless with every tool, MCP server, setting file and
// skill switched off, in an empty directory with a minimal environment. Works
// with a subscription login. The process reports what it has available before
// answering; if that list is not empty the answer is thrown away.
//
// The CLI adds a little of its own to the model's context: the account email,
// the OS version, the working directory and the date. Callers should pass
// `cliPrivateValues()` to the front desk so replies containing them are dropped.
export function claudeCli(opts: ClaudeCliOptions = {}): Model {
  const model = opts.model ?? "claude-sonnet-5-5";
  const bin = opts.bin ?? "claude";
  return ({ system, prompt, timeoutMs }) =>
    new Promise<string>((resolve, reject) => {
      const cwd = mkdtempSync(join(tmpdir(), "cpart-desk-"));
      // The prompt goes in a private file, not on the command line: arguments
      // are visible to other local users and limited in size.
      const promptFile = join(cwd, "system.txt");
      writeFileSync(promptFile, system, { mode: 0o600 });
      const env: Record<string, string> = {};
      for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR"]) if (process.env[k]) env[k] = process.env[k]!;
      const child = spawn(
        bin,
        ["-p", "--system-prompt-file", promptFile, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--model", model, "--output-format", "stream-json", "--verbose"],
        { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true },
      );
      let out = "";
      let err = "";
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killGroup();
        rmSync(cwd, { recursive: true, force: true });
        fn();
      };
      // Kill the whole process group, so helpers the CLI started cannot outlive it.
      const killGroup = (): void => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(() => settle(() => reject(new ModelError("the model timed out", "front desk model timed out"))), timeoutMs ?? opts.timeoutMs ?? 180_000);
      child.stdout.on("data", (d: Buffer) => {
        out += d;
        if (out.length > MAX_OUTPUT) settle(() => reject(new ModelError("the model wrote too much", "front desk model produced too much output")));
      });
      child.stderr.on("data", (d: Buffer) => {
        if (err.length < 4096) err += d;
      });
      child.stdin.on("error", () => {});
      child.on("error", (e: NodeJS.ErrnoException) =>
        settle(() =>
          reject(
            e.code === "ENOENT" ? new ModelError("claude was not found", `${bin} was not found on PATH=${env.PATH ?? ""}`)
            : e.code === "EACCES" ? new ModelError("claude could not be started", `${bin} could not be started: permission denied. PATH=${env.PATH ?? ""}`)
            : e,
          ),
        ),
      );
      child.on("close", (code) =>
        settle(() => {
          let bare = false;
          let result: string | null = null;
          // The CLI's own name for what went wrong, like "authentication_failed".
          // Only a plain word is kept: it names the failure and nothing else.
          let failure: string | null = null;
          for (const line of out.split("\n")) {
            let j: Record<string, unknown>;
            try {
              j = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (j.type === "system" && j.subtype === "init") bare = Array.isArray(j.tools) && j.tools.length === 0 && Array.isArray(j.mcp_servers) && j.mcp_servers.length === 0;
            if (j.type === "assistant" && typeof j.error === "string" && /^[a-z_]{1,40}$/.test(j.error)) failure ??= j.error;
            if (j.type === "result" && j.is_error !== true && typeof j.result === "string") result = j.result;
          }
          const config = env.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}` : `CLAUDE_CONFIG_DIR not set, so ${join(env.HOME ?? homedir(), ".claude")}`;
          if (failure === "authentication_failed") return reject(new ModelError("claude is not logged in", `claude is not logged in (${config})`));
          if (failure) return reject(new ModelError(`claude failed: ${failure}`, `claude exited ${code}: ${failure}`));
          if (!bare && out.trim() === "") return reject(new ModelError(`claude exited ${code}`, `claude exited ${code}: ${firstLine(err) || "no output"}`));
          if (!bare) return reject(new ModelError("claude did not start without tools", "front desk model was not started without tools; refusing its output"));
          if (result === null) return reject(new ModelError(`claude exited ${code} with no answer`, `claude exited ${code}: ${firstLine(err) || "no result"}`));
          resolve(result);
        }),
      );
      child.stdin.end(prompt);
    });
}

const firstLine = (s: string): string => s.trim().split("\n")[0]!.slice(0, 300);

// Values the claude CLI is known to put in the model's context, plus a few
// local identifiers, for the front desk's outbound filter.
export function cliPrivateValues(): string[] {
  const values = [release(), hostname(), homedir(), userInfo().username];
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    const account = (JSON.parse(readFileSync(dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json"), "utf8")) as { oauthAccount?: Record<string, unknown> }).oauthAccount ?? {};
    for (const k of ["emailAddress", "fullName", "displayName", "organizationName", "accountUuid", "organizationUuid"]) if (typeof account[k] === "string") values.push(account[k]);
  } catch {
    /* no account file */
  }
  return values;
}

export interface AnthropicApiOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

// Calls the Messages API directly. The model's context is exactly the system
// prompt and the thread, with nothing added, and no tools are declared. A
// response that holds anything but text is refused: with no tools declared
// there should be none, and if there is the answer is not trusted.
//
// Tested against a local fake server only. `scripts/frontdesk-api-check.sh`
// runs it against the real API when the owner has a key.
export function anthropicApi(opts: AnthropicApiOptions): Model {
  return async ({ system, prompt, timeoutMs }) => {
    const res = await fetch(`${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: opts.model ?? "claude-sonnet-5-5", max_tokens: opts.maxTokens ?? 2000, system, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs ?? opts.timeoutMs ?? 180_000),
    });
    if (res.status === 401 || res.status === 403) throw new ModelError("the API key was refused", `model API returned ${res.status}`);
    if (!res.ok) throw new ModelError(`model API returned ${res.status}`);
    const body = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const content = Array.isArray(body?.content) ? body.content : [];
    if (content.some((c) => c?.type !== "text" || typeof c.text !== "string")) throw new Error("model API returned something other than text; refusing its output");
    const text = content.map((c) => c.text).join("");
    if (!text) throw new Error("model API returned no text");
    return text;
  };
}
