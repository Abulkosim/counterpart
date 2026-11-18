// A relay run on this machine: where its database goes, and the files that
// make it a service (systemd unit, launchd agent) for `cpart relay --boot`.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RELAY_HOME, defaultRelayDb, oldDbNotice, relayServiceName, relayServices } from "../src/relay-service.ts";
import { type ServiceSpec, MAIN, installService, listServices, plistText, unitText } from "../src/service.ts";

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

test("a relay keeps its database beside the identity homes, one file per port", () => {
  const prev = process.env.CPART_RELAY_HOME;
  try {
    delete process.env.CPART_RELAY_HOME;
    assert.equal(DEFAULT_RELAY_HOME, join(homedir(), ".counterpart-relay"));
    const rh = join(tmp(), "relays");
    process.env.CPART_RELAY_HOME = rh;
    assert.equal(defaultRelayDb(7447), join(rh, "relay-7447.db"));
    assert.equal(defaultRelayDb(8080), join(rh, "relay-8080.db"));
    assert.ok(existsSync(rh), "the relay home is made");
    // A service name per relay home and port; the plain name only for the default ones.
    assert.equal(relayServiceName(DEFAULT_RELAY_HOME, 7447), "cpart-relay");
    assert.match(relayServiceName(rh, 7447), /^cpart-relay-[0-9a-f]{8}$/);
    assert.notEqual(relayServiceName(rh, 7447), relayServiceName(rh, 7448));
  } finally {
    if (prev === undefined) delete process.env.CPART_RELAY_HOME;
    else process.env.CPART_RELAY_HOME = prev;
  }
  const project = tmp();
  assert.equal(oldDbNotice(project, "/x/relay-7447.db"), undefined);
  writeFileSync(join(project, "relay.db"), "");
  assert.match(oldDbNotice(project, "/x/relay-7447.db") ?? "", /relay\.db in this directory, from an older version[\s\S]*--db relay\.db/);
  assert.equal(oldDbNotice(project, join(project, "relay.db")), undefined, "no notice when it is the one in use");
});

const spec = (name: string, meta?: string) => ({
  name,
  description: "Counterpart relay on port 7447",
  args: [MAIN, "relay", "--port", "7447", "--db", "/a 100% $HOME/<b>&c.db"],
  env: { CPART_RELAY_HOME: "/a 100%" },
  log: "/a 100%/relay-7447.log",
  ...(meta ? { meta } : {}),
});

test("the systemd unit quotes what systemd would expand, and keeps the meta line", () => {
  const t = unitText(spec("cpart-relay", "cpart-relay eyJ4IjoxfQ=="));
  assert.ok(t.startsWith("# cpart-relay eyJ4IjoxfQ==\n[Unit]\n"));
  assert.match(t, /^ExecStart="[^"]+" "[^"]+main\.ts" "relay" "--port" "7447" "--db" "\/a 100%% \$\$HOME\/<b>&c\.db"$/m);
  assert.match(t, /^Environment="CPART_RELAY_HOME=\/a 100%%"$/m);
  assert.match(t, /^Restart=always$/m);
  assert.match(t, /^StandardOutput=append:\/a 100%%\/relay-7447\.log$/m);
});

test("the launchd agent is a valid property list with the meta comment", { skip: spawnSync("python3", ["--version"]).status !== 0 ? "no python3" : false }, () => {
  const f = join(tmp(), "a.plist");
  writeFileSync(f, plistText(spec("cpart-relay", "cpart-relay eyJ4IjoxfQ==")));
  const py = "import plistlib, sys, json\nwith open(sys.argv[1], 'rb') as f: p = plistlib.load(f)\nprint(json.dumps(p))";
  const p = JSON.parse(execFileSync("python3", ["-I", "-c", py, f], { encoding: "utf8" })) as { Label: string; ProgramArguments: string[]; KeepAlive: boolean; RunAtLoad: boolean };
  assert.equal(p.Label, "dev.counterpart.cpart-relay");
  assert.deepEqual(p.ProgramArguments.slice(1), [MAIN, "relay", "--port", "7447", "--db", "/a 100% $HOME/<b>&c.db"]);
  assert.equal(p.KeepAlive, true);
  assert.equal(p.RunAtLoad, true);
});

test("installed relay services are found from their files, and nothing else is", () => {
  const prev = process.env.HOME;
  const h = tmp();
  try {
    process.env.HOME = h;
    const units = join(h, ".config/systemd/user");
    const agents = join(h, "Library/LaunchAgents");
    mkdirSync(units, { recursive: true });
    mkdirSync(agents, { recursive: true });
    const meta = (port: number): string => `cpart-relay ${Buffer.from(JSON.stringify({ home: "/r", port, host: "127.0.0.1", db: `/r/relay-${port}.db`, urls: ["ws://a:1"] })).toString("base64")}`;
    writeFileSync(join(units, "cpart-relay.service"), unitText(spec("cpart-relay", meta(7447))));
    writeFileSync(join(agents, "dev.counterpart.cpart-relay-0badf00d.plist"), plistText(spec("cpart-relay-0badf00d", meta(9000))));
    // The daemon's own unit, a damaged one and somebody else's are left out.
    writeFileSync(join(units, "cpart.service"), unitText(spec("cpart")));
    writeFileSync(join(units, "cpart-relay-damaged.service"), "# cpart-relay !!!\n");
    writeFileSync(join(units, "other.service"), "# cpart-relay e30=\n");
    assert.deepEqual(listServices("cpart-relay").map((s) => s.name).sort(), ["cpart-relay", "cpart-relay-0badf00d", "cpart-relay-damaged"]);
    const found = relayServices();
    assert.deepEqual(found.map((s) => [s.name, s.kind, s.port, s.db, s.log]), [
      ["cpart-relay", "systemd", 7447, "/r/relay-7447.db", "/r/relay-7447.log"],
      ["cpart-relay-0badf00d", "launchd", 9000, "/r/relay-9000.db", "/r/relay-9000.log"],
    ]);
    assert.deepEqual(found[0]!.urls, ["ws://a:1"]);
  } finally {
    process.env.HOME = prev;
  }
});

test("relay --boot refuses a tunnel, and says so when nothing can start it at login", () => {
  const env = { CPART_RELAY_HOME: join(tmp(), "relays") };
  assert.match(cli(["relay", "--boot", "--tunnel"], env).out, /--tunnel and --boot do not go together/);
  assert.match(cli(["relay", "--boot", "--port", "1"], env).out, /CPART_NO_BOOT is set, so nothing was installed/);
  assert.match(cli(["relay", "--port", "x"], env).out, /--port takes a number/);
  assert.match(cli(["relay", "--port", "0"], env).out, /--port takes a number from 1 to 65535/);
  assert.match(cli(["relay", "--boot", "--host", "127.0.0.1\nExecStartPre=/bin/true"], { ...env, CPART_NO_BOOT: "", HOME: tmp() }).out, /cannot hold line breaks/);
});

test("no value with a line break is written into a service file, for the relay or the daemon", () => {
  const prev = process.env.HOME;
  const h = tmp();
  try {
    process.env.HOME = h;
    const bad: ServiceSpec[] = [
      { ...spec("cpart-relay-x"), env: { CPART_RELAY_HOME: "/r\nExecStartPre=/bin/true" } },
      { ...spec("cpart-x"), description: "Counterpart daemon", env: { CPART_HOME: "/h\nExecStartPre=/bin/true", PATH: "/usr/bin" } },
      { ...spec("cpart-relay-y"), log: "/r\n/relay.log" },
    ];
    for (const s of bad) for (const kind of ["systemd", "launchd"] as const) assert.throws(() => installService(kind, s), /line break or other control character[\s\S]*Nothing was installed/);
    assert.ok(!existsSync(join(h, ".config")) && !existsSync(join(h, "Library")), "a file was written");
  } finally {
    process.env.HOME = prev;
  }
  // From the command line: a relay home with a line break stops --boot before anything is written.
  const h2 = tmp();
  const r = cli(["relay", "--boot", "--port", "1"], { CPART_NO_BOOT: "", HOME: h2, CPART_RELAY_HOME: `${h2}/rh\nExecStartPre=/bin/true` });
  assert.match(r.out, /CPART_RELAY_HOME cannot hold line breaks|nothing here can start a program at login/);
  assert.ok(!existsSync(join(h2, ".config")), "a unit file was written");
});
