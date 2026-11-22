// Write the launchd agent that `cpart up --boot` writes on a Mac, here, without
// a Mac: the platform is reported as darwin, HOME is a temporary directory and
// `launchctl` is a stand-in that only records its arguments. Then parse the
// file with Python's plistlib and print what launchd would read.
//   node scripts/launchd-plist-check.ts
// This checks the file is a valid property list with the intended fields. It
// does not show that launchd starts the daemon: that needs a Mac.
// Needs node 24 and python3. No model, no network. 13 s on a shared 2-core machine.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(os.tmpdir(), "cpart-plist-"));
try {
  // A home with characters that must be escaped in XML, and a space.
  const home = join(root, "a & <b> home");
  mkdirSync(home, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$@" >> "${join(root, "launchctl.args")}"\n`);
  chmodSync(join(bin, "launchctl"), 0o755);
  process.env.HOME = root;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  delete process.env.CPART_NO_BOOT;
  os.platform = () => "darwin";
  syncBuiltinESMExports();
  const { up } = await import("../packages/cli/src/service.ts");
  // Nothing starts: launchctl is a stand-in. up() waits for a daemon, then gives up.
  await up(home, { boot: true });
  const dir = join(root, "Library/LaunchAgents");
  const file = join(dir, readdirSync(dir)[0]!);
  console.log(`launchctl was called with: ${readFileSync(join(root, "launchctl.args"), "utf8").trim()}`);
  const py = `
import plistlib, sys, json
with open(sys.argv[1], "rb") as f:
    p = plistlib.load(f)
print(json.dumps(p, indent=2, sort_keys=True))
`;
  console.log(execFileSync("python3", ["-I", "-c", py, file], { encoding: "utf8" }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
