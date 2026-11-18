// What a new person meets in the CLI: per-command help.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandHelp } from "../src/help.ts";
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
  for (const f of ["--no-agents", "--no-passphrase", "--yes", "cpart relay --boot", "cpart <command> --help"]) assert.ok(usage().includes(f), `usage lacks ${f}`);
});
