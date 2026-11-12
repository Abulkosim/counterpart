import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, release, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export interface ModelRequest {
  system: string;
  prompt: string;
}
// A model here is text in, text out. It is given no tools; adapters must make
// sure of that themselves and refuse to run otherwise.
export type Model = (req: ModelRequest) => Promise<string>;

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
  return ({ system, prompt }) =>
    new Promise<string>((resolve, reject) => {
      const cwd = mkdtempSync(join(tmpdir(), "cpart-desk-"));
      // The prompt goes in a private file, not on the command line: arguments
      // are visible to other local users and limited in size.
      const promptFile = join(cwd, "system.txt");
      writeFileSync(promptFile, system, { mode: 0o600 });
      const env: Record<string, string> = {};
      for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR"]) if (process.env[k]) env[k] = process.env[k]!;
      const child = spawn(
        opts.bin ?? "claude",
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
      const timer = setTimeout(() => settle(() => reject(new Error("front desk model timed out"))), opts.timeoutMs ?? 180_000);
      child.stdout.on("data", (d: Buffer) => {
        out += d;
        if (out.length > MAX_OUTPUT) settle(() => reject(new Error("front desk model produced too much output")));
      });
      child.stderr.on("data", (d: Buffer) => {
        if (err.length < 4096) err += d;
      });
      child.stdin.on("error", () => {});
      child.on("error", (e) => settle(() => reject(e)));
      child.on("close", (code) =>
        settle(() => {
          let bare = false;
          let result: string | null = null;
          for (const line of out.split("\n")) {
            let j: Record<string, unknown>;
            try {
              j = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (j.type === "system" && j.subtype === "init") bare = Array.isArray(j.tools) && j.tools.length === 0 && Array.isArray(j.mcp_servers) && j.mcp_servers.length === 0;
            if (j.type === "result" && j.is_error !== true && typeof j.result === "string") result = j.result;
          }
          if (!bare) return reject(new Error("front desk model was not started without tools; refusing its output"));
          if (result === null) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300) || "no result"}`));
          resolve(result);
        }),
      );
      child.stdin.end(prompt);
    });
}

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
// prompt and the thread, with nothing added, and no tools are declared.
export function anthropicApi(opts: AnthropicApiOptions): Model {
  return async ({ system, prompt }) => {
    const res = await fetch(`${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: opts.model ?? "claude-sonnet-5-5", max_tokens: opts.maxTokens ?? 2000, system, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    if (!res.ok) throw new Error(`model API returned ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (body.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
    if (!text) throw new Error("model API returned no text");
    return text;
  };
}
