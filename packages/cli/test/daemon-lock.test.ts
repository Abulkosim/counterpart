// One daemon per home, and the lock that decides it. Looking for a daemon
// takes the lock for a moment, so a daemon that starts while other processes
// look must still win, and a look must not be taken for a daemon.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { claim, running } from "../src/service.ts";

const SERVICE = join(import.meta.dirname, "../src/service.ts");
const dirs: string[] = [];
const kids: ChildProcess[] = [];
after(() => {
  for (const k of kids) k.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cpart-lock-"));
  dirs.push(d);
  return d;
};

// A child process that runs `code` and says "ready" on stdout once it has started.
async function child(code: string): Promise<ChildProcess> {
  const k = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  kids.push(k);
  let out = "";
  k.stdout!.setEncoding("utf8");
  while (!out.includes("ready")) {
    const [chunk] = (await once(k.stdout!, "data")) as [string];
    out += chunk;
  }
  return k;
}

// Takes and drops the lock as fast as it can, the way `running` looks, for `ms`.
const looker = (home: string, ms: number): string => `
  import { DatabaseSync } from "node:sqlite";
  const end = Date.now() + ${ms};
  let first = true;
  while (Date.now() < end) {
    const db = new DatabaseSync(${JSON.stringify(join(home, "daemon.lock"))});
    try { db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS held (x); COMMIT; BEGIN EXCLUSIVE"); } catch {}
    db.close();
    if (first) { console.log("ready"); first = false; }
  }`;

test("a daemon starts while other processes look for one, and a look is not a daemon", async () => {
  const home = tmp();
  claim(home, "ws://127.0.0.1:1").release(); // creates the lock file
  const k = await child(looker(home, 4000));
  // Before the fix a start that met a look said "a daemon is already running"
  // and exited, and `cpart up` reported that the daemon did not start.
  for (let i = 0; i < 5; i++) {
    assert.equal(running(home), undefined, "a look was taken for a daemon");
    const held = claim(home, "ws://127.0.0.1:1");
    assert.equal(running(home)?.pid, process.pid);
    held.release();
  }
  k.kill();
});

test("a second daemon for a home is refused, and told which one holds it", async () => {
  const home = tmp();
  const k = await child(`
    const { claim } = await import(${JSON.stringify(SERVICE)});
    globalThis.held = claim(${JSON.stringify(home)}, "ws://127.0.0.1:1");
    console.log("ready");
    setInterval(() => {}, 1000);`);
  assert.equal(running(home)?.pid, k.pid);
  assert.throws(() => claim(home, "ws://127.0.0.1:1"), new RegExp(`a daemon is already running for .* \\(pid ${k.pid}\\)`));
  k.kill("SIGKILL");
  await once(k, "exit");
  // The operating system dropped its lock, so the state it left behind does not count.
  assert.equal(running(home), undefined);
  claim(home, "ws://127.0.0.1:1").release();
});
