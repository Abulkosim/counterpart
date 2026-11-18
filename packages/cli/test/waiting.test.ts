import { test } from "node:test";
import assert from "node:assert/strict";
import { refusedLine, unansweredLines } from "../src/waiting.ts";

const u = { thread: "Kd8f2a1bXXXXXXXXXXXXXX", contact: "maya", opened: true, openedHere: false, messages: 2, firstOrd: 3, lastOrd: 5, lastAt: 0 };
const safe = (s: string): string => s;

test("status names the contact, the thread and the counts, with the next command", () => {
  assert.deepEqual(unansweredLines([u], 3 * 60_000), [
    `  maya wrote in thread Kd8f2a1b: new thread, 2 messages, the last 3 minutes ago. Nobody here has read it\n      cpart log Kd8f2a1b, then cpart say Kd8f2a1b "...", or answer from Claude Code or Codex`,
  ]);
  assert.match(unansweredLines([{ ...u, opened: false, messages: 1 }], 30_000)[0]!, /: 1 message, the last less than a minute ago\./);
  assert.match(unansweredLines([{ ...u, messages: 0 }], 3 * 3600_000)[0]!, /: new thread, the last 3 hours ago\./);
  const many = unansweredLines(Array.from({ length: 7 }, (_, i) => ({ ...u, thread: `${i}`.repeat(22) })), 0);
  assert.equal(many.length, 6);
  assert.equal(many[5], "  and 2 more threads like these\n      cpart threads");
});

test("a refused login is said once the daemon has heard it, with what fixes it", () => {
  const home = "ws://127.0.0.1:7447";
  const row = { url: home, connected: false, at: 100, error: "refused the login: wrong_relay_url" };
  assert.match(refusedLine(home, [row], 50, safe)[0]!, /^ {2}the relay at ws:\/\/127\.0\.0\.1:7447 refused to log you in \(wrong_relay_url\)\. Nothing is sent or received until it lets you in\n {6}whoever runs the relay must restart it with --url ws:\/\/127\.0\.0\.1:7447/);
  assert.match(refusedLine(home, [{ ...row, error: "refused the login: auth_failed" }], 50, safe)[0]!, /date -u/);
  // Heard before this daemon started, connected, another relay, or another error: nothing.
  assert.deepEqual(refusedLine(home, [row], 150, safe), []);
  assert.deepEqual(refusedLine(home, [{ ...row, connected: true, error: null }], 50, safe), []);
  assert.deepEqual(refusedLine(home, [{ ...row, url: "ws://other" }], 50, safe), []);
  assert.deepEqual(refusedLine(home, [{ ...row, error: "ECONNREFUSED" }], 50, safe), []);
});
