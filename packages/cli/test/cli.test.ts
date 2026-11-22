// What a new person meets in the CLI: per-command help, join without a
// terminal, the passphrase prompt, and the hint after pairing.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandHelp } from "../src/help.ts";
import { nextStep } from "../src/pair.ts";
import { MAIN } from "../src/service.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cpart-cli-"));
  dirs.push(d);
  return d;
};
// The CLI as a person runs it, without a terminal on stdin.
const cli = (args: string[], env: Record<string, string> = {}): { code: number; out: string } => {
  const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", input: "", env: { ...process.env, CPART_NO_BOOT: "1", CPART_NO_AUTOSTART: "1", ...env } });
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
};
let full: string | undefined;
const usage = (): string => (full ??= cli(["help"]).out);

test("each main command has its own help, with the flags a new person needs", () => {
  const setup = cli(["setup", "--help"]).out;
  for (const f of ["--relay", "--no-agents", "--no-hooks", "--no-passphrase", "--no-boot"]) assert.match(setup, new RegExp(f), `setup --help lacks ${f}`);
  assert.ok(!setup.includes("cpart propose"), "setup --help printed the whole list");
  const join = cli(["join", "--help"]).out;
  for (const f of ["--yes", "--no-agents", "--no-passphrase"]) assert.match(join, new RegExp(f), `join --help lacks ${f}`);
  const relay = cli(["relay", "--help"]).out;
  for (const f of ["--boot", "--no-boot", "--db", "~/.counterpart-relay", "--tunnel", "cpart relay move"]) assert.ok(relay.includes(f), `relay --help lacks ${f}`);
  assert.equal(cli(["help", "relay"]).out, relay);
  for (const c of ["invite", "up", "down", "status"]) assert.ok(cli([c, "--help"]).out.startsWith(`cpart ${c}`), `${c} --help`);
  // The rest are cut out of the full usage.
  assert.match(cli(["say", "--help"]).out, /^ {2}cpart say <thread> <text>\n\nAll commands: cpart help\n$/);
  assert.match(commandHelp("approve", usage()) ?? "", /cpart approve <thread> <id> +sign it/);
  assert.match(commandHelp("release", usage()) ?? "", /^Outbound guard/);
  assert.equal(commandHelp("nosuch", usage()), undefined);
  assert.match(cli(["nosuch", "--help"]).out, /^No command "nosuch"\.\n\ncpart: let your agent/);
  // The full list names the flags too, and says how to get one command's help.
  for (const f of ["--no-agents", "--no-passphrase", "--yes", "cpart relay --boot", "cpart <command> --help", "cpart --version"]) assert.ok(usage().includes(f), `usage lacks ${f}`);
});

test("--version and -v print the root package.json version and nothing else", () => {
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8")) as { version: string };
  for (const flag of ["--version", "-v"]) assert.deepEqual(cli([flag]), { code: 0, out: `${version}\n` });
});

test("join without a terminal says why it stops and which flag goes on", () => {
  const home = join(tmp(), "home");
  // The relay is not contacted before the question, so nothing needs to listen.
  const r = cli(["join", "7-cider-otter@ws://127.0.0.1:9", "alice"], { CPART_HOME: home });
  assert.equal(r.code, 1);
  assert.match(r.out, /this needs a terminal: the code or invite names a relay on your own machine or network \(ws:\/\/127\.0\.0\.1:9\)/);
  assert.match(r.out, /run the same command again with --yes/);
  assert.match(r.out, /Nothing was created/);
  assert.ok(!existsSync(join(home, "keys.json")));
});

test("the passphrase prompt says everything the passphrase is for", { skip: spawnSync("python3", ["--version"]).status !== 0 ? "no python3" : false }, () => {
  // A pseudo-terminal, so the prompt is shown. Ctrl-C at the prompt ends it.
  const py = `
import os, pty, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out = b""
end = time.time() + 20
while time.time() < end and b"Passphrase (8" not in out:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: out += os.read(fd, 4096)
        except OSError: break
os.write(fd, b"\\x03")
time.sleep(0.5)
sys.stdout.write(out.decode("utf8", "replace"))
`;
  const env: NodeJS.ProcessEnv = { ...process.env, CPART_HOME: join(tmp(), "home") };
  delete env.CPART_PASSPHRASE;
  const shown = execFileSync("python3", ["-I", "-c", py, process.execPath, MAIN, "init", "--relay", "ws://127.0.0.1:9"], { encoding: "utf8", env });
  for (const w of ["approve a contract", "release or drop a held message", "share files", "turn the guard off", "renew this device", "Passphrase (8 characters or more)"]) assert.ok(shown.includes(w), `prompt lacks "${w}": ${shown}`);
});

test("after pairing, the agent hint shows only where an agent has the tools", () => {
  assert.match(nextStep("bob", true), /in Claude Code or Codex, say something like/);
  const none = nextStep("bob", false);
  assert.ok(!none.includes("say something like"));
  assert.match(none, /cpart open bob "<what it is about>" --say "<first message>"/);
  assert.match(none, /cpart setup/);
});
