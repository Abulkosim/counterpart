import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ModelRequest {
  system: string;
  prompt: string;
}
// A model here is text in, text out. It is given no tools; adapters must make
// sure of that themselves and refuse to run otherwise.
export type Model = (req: ModelRequest) => Promise<string>;

export interface ClaudeCliOptions {
  model?: string;
  bin?: string;
  timeoutMs?: number;
}

// Runs Claude Code headless with every tool, MCP server, setting file and
// skill switched off, in an empty directory with a minimal environment. Works
// with a subscription login. The process reports what it has available before
// answering; if that list is not empty the answer is thrown away.
export function claudeCli(opts: ClaudeCliOptions = {}): Model {
  const model = opts.model ?? "claude-sonnet-5-5";
  return ({ system, prompt }) =>
    new Promise<string>((resolve, reject) => {
      const cwd = mkdtempSync(join(tmpdir(), "cpart-desk-"));
      const env: Record<string, string> = {};
      for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR"]) if (process.env[k]) env[k] = process.env[k]!;
      const child = spawn(
        opts.bin ?? "claude",
        ["-p", "--system-prompt", system, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--model", model, "--output-format", "stream-json", "--verbose"],
        { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 180_000);
      child.stdout.on("data", (d: Buffer) => (out += d));
      child.stderr.on("data", (d: Buffer) => (err += d));
      child.on("error", (e) => done(() => reject(e)));
      child.on("close", (code) =>
        done(() => {
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
      function done(fn: () => void): void {
        clearTimeout(timer);
        rmSync(cwd, { recursive: true, force: true });
        fn();
      }
    });
}
