import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult, FrontDesk } from "@counterpart/frontdesk";
import { deskCheck, explain } from "../src/desk-check.ts";

const io = { boot: () => undefined, safe: (s: string) => s, log: "/h/daemon.log" };
const cli = (over: Partial<Extract<CheckResult["setup"], { kind: "claude-cli" }>> = {}): CheckResult["setup"] => ({ kind: "claude-cli", bin: "claude", found: "/opt/bin/claude", path: "/usr/bin:/bin", configDir: null, defaultConfigDir: "/home/a/.claude", ...over });

test("a failed check says where the daemon looked and how to fix it", () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/home/a/.claude-work";
  try {
    const out = explain({ ok: false, short: "claude is not logged in", detail: "claude is not logged in (CLAUDE_CONFIG_DIR not set, so /home/a/.claude)", setup: cli() }, io);
    assert.match(out, /cannot run from the daemon: claude is not logged in/);
    assert.match(out, /claude {6}\/opt\/bin\/claude/);
    assert.match(out, /PATH {8}\/usr\/bin:\/bin/);
    assert.match(out, /config {6}\/home\/a\/\.claude \(CLAUDE_CONFIG_DIR not set\)/);
    assert.match(out, /This shell has CLAUDE_CONFIG_DIR=\/home\/a\/\.claude-work; the daemon has none\. If claude is logged in here, restart the daemon: cpart down, then cpart up/);
    assert.match(out, /Fix: log claude in for the daemon's config: claude auth login/);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
  const missing = explain({ ok: false, short: "claude was not found", detail: "claude was not found on PATH=/usr/bin:/bin", setup: cli({ found: null }) }, { ...io, boot: () => "launchd" });
  assert.match(missing, /claude {6}not found \(it looks for "claude" on PATH\)/);
  assert.match(missing, /Fix: put claude on the daemon's PATH, then restart the daemon: cpart down, then cpart up --boot/);
  const api = explain({ ok: false, short: "the API key was refused", detail: "model API returned 401", setup: { kind: "api", baseUrl: "https://api.anthropic.com" } }, io);
  assert.match(api, /Messages API at https:\/\/api\.anthropic\.com with the ANTHROPIC_API_KEY it was started with/);
});

// Only the parts of the desk the check uses.
function fakeDesk(answer: (n: number) => ReturnType<FrontDesk["checkResult"]>): FrontDesk & { cancelled: number[] } {
  let polls = 0;
  const cancelled: number[] = [];
  return { requestCheck: () => 7, checkResult: () => answer(++polls), cancelCheck: (id: number) => void cancelled.push(id), cancelled } as unknown as FrontDesk & { cancelled: number[] };
}

test("the check waits for the daemon, and says so when there is none or it does not answer", async () => {
  const wait = { pickupMs: 100, pollMs: 5 };
  const ok = await deskCheck(fakeDesk((n) => (n < 3 ? "running" : { ok: true, short: null, detail: null, setup: null })), { ...io, daemon: async () => true, wait });
  assert.equal(ok.ok, true);
  const none = await deskCheck(fakeDesk(() => "waiting"), { ...io, daemon: async () => false, wait });
  assert.ok(!none.ok && none.kind === "no-daemon" && /Start it: cpart up/.test(none.text));
  const silent = fakeDesk(() => "waiting");
  const old = await deskCheck(silent, { ...io, daemon: async () => true, wait });
  assert.ok(!old.ok && old.kind === "no-answer" && /restart it: cpart down, then cpart up/.test(old.text));
  assert.deepEqual(silent.cancelled, [7], "a request no daemon took is withdrawn");
  const failed = await deskCheck(fakeDesk(() => ({ ok: false, short: "claude exited 1", detail: "claude exited 1: boom", setup: cli() })), { ...io, daemon: async () => true, wait });
  assert.ok(!failed.ok && failed.kind === "failed" && /claude exited 1: boom/.test(failed.text));
});
