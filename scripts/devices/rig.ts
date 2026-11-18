// The two devices, the network between them and the relay, and the faults.
// Everything here shells out to docker and to the cpart CLI inside a device.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEVICES = ["laptop", "devcontainer"] as const;
export type Device = (typeof DEVICES)[number];
export const other = (d: Device): Device => (d === "laptop" ? "devcontainer" : "laptop");
// mac: the relay runs in the laptop's own network namespace, as a relay on a
// Mac would. The laptop dials it as ws://127.0.0.1:7447, the devcontainer as
// ws://host.docker.internal:7447, a name that points at the laptop.
export type Mode = "host" | "container" | "tunnel" | "mac";
export type RelayName = "relay" | "relay2";
export const SPARE_URL = "ws://relay-b:7447";

export interface Run {
  code: number;
  out: string;
  err: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Runs a command to completion. Never throws; a timeout kills it and returns code 124.
export function sh(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: opts.env ?? process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, out, err: err + e.message });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: signal === "SIGKILL" ? 124 : (code ?? 1), out, err });
    });
    // A command that exits without reading its input is not an error here.
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });
}

export interface RigOptions {
  work: string;
  id: string;
  image: string;
  mode: Mode | "auto";
  port: number;
  // Container, network and image names start with this.
  prefix: string;
  creds: Partial<Record<Device, string>>;
  log: (line: string) => void;
}

// The relay as the devices reach it.
export interface RelayInfo {
  mode: Mode;
  url: string;
  note: string;
  // A second relay the devices can add: container mode only.
  spare?: string;
}

// Runs a command in a device on a pseudo-terminal and types the answer at its
// passphrase prompt, as a person at a keyboard would: cpart release reads the
// passphrase from a terminal only. The answer goes through the environment,
// not the arguments.
const ON_TERMINAL = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out, sent, end = b"", False, time.time() + 90
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if not r:
        continue
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    out += d
    if not sent and b"passphrase: " in out.lower():
        time.sleep(0.2)
        os.write(fd, os.environ["PTY_ANSWER"].encode() + b"\\r")
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;

export class Rig {
  readonly o: RigOptions;
  readonly net: string;
  subnet = "";
  private ips: Record<Device, number> = { laptop: 10, devcontainer: 20 };
  relay: RelayInfo | undefined;
  private relayProc: ChildProcess | undefined;
  private owned = false;
  private paused = new Set<Device>();
  private offline = new Set<Device>();
  // Devices back on the network at a new address whose daemon has not been
  // restarted since. Their link may be dead while status says connected.
  private moved = new Set<Device>();
  readonly trace: string;

  constructor(o: RigOptions) {
    this.o = o;
    this.net = `${o.prefix}-${o.id}`;
    this.trace = join(o.work, "rig.log");
  }

  name(d: Device | RelayName): string {
    return `${this.o.prefix}-${this.o.id}-${d}`;
  }

  private note(line: string): void {
    appendFileSync(this.trace, `${new Date().toISOString()} ${line}\n`);
    this.o.log(line);
  }

  private async docker(args: string[], timeoutMs = 120_000): Promise<Run> {
    const r = await sh("docker", args, { timeoutMs });
    appendFileSync(this.trace, `${new Date().toISOString()} docker ${args.filter((a) => !a.includes("credentials")).join(" ").slice(0, 300)} -> ${r.code}${r.code ? ` ${r.err.trim().slice(0, 300)}` : ""}\n`);
    return r;
  }

  private async must(args: string[], timeoutMs?: number): Promise<string> {
    const r = await this.docker(args, timeoutMs);
    if (r.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${r.err.trim() || r.out.trim()}`);
    return r.out.trim();
  }

  // A network of our own with a subnet we pick, so a device can come back
  // from a drop with a different address, as a laptop on a new Wi-Fi would.
  async createNetwork(): Promise<void> {
    const seed = [...this.o.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
    for (let n = 0; n < 40; n++) {
      const third = 100 + ((seed + n) % 150);
      const subnet = `10.234.${third}.0/24`;
      const r = await this.docker(["network", "create", "--driver", "bridge", "--subnet", subnet, this.net]);
      if (r.code === 0) {
        this.owned = true;
        this.subnet = `10.234.${third}`;
        this.note(`network ${this.net} ${subnet}`);
        return;
      }
      if (!/overlap|in use/i.test(r.err)) throw new Error(`docker network create: ${r.err.trim()}`);
    }
    throw new Error("no free 10.234.x.0/24 subnet for the rig's network");
  }

  ip(d: Device): string {
    return `${this.subnet}.${this.ips[d]}`;
  }

  // The relay. host: a process on this machine, reached through
  // host.docker.internal (host-gateway). container: a third container on the
  // devices' network, reached by the same name. tunnel: a process on this
  // machine behind `cpart relay --tunnel`.
  async startRelay(): Promise<RelayInfo> {
    const want = this.o.mode;
    if (want === "host" || want === "auto") {
      const ok = await this.startHostRelay();
      if (ok) return (this.relay = { mode: "host", url: `ws://host.docker.internal:${this.o.port}`, note: "relay process on this machine, reached through host.docker.internal (host-gateway)" });
      this.stopHostRelay();
      const why = "the devices could not reach a relay on this machine through host.docker.internal: this host's firewall drops traffic from Docker bridges to the host";
      if (want === "host") throw new Error(`${why}. Allow it (for example: sudo ufw allow in on docker0 to 172.17.0.1 port ${this.o.port} proto tcp) or use --mode container`);
      this.note(`${why}. Falling back to a relay container named host.docker.internal on the devices' network.`);
      await this.startRelayContainer();
      await this.startRelayContainer("relay2");
      return (this.relay = { mode: "container", url: "ws://host.docker.internal:7447", spare: SPARE_URL, note: `${why}, so the relay runs in a third container that the devices reach by the same name, host.docker.internal; a spare relay in a fourth, reached as relay-b` });
    }
    if (want === "container") {
      await this.startRelayContainer();
      await this.startRelayContainer("relay2");
      return (this.relay = { mode: "container", url: "ws://host.docker.internal:7447", spare: SPARE_URL, note: "relay in a third container on the devices' network, reached as host.docker.internal; a spare relay in a fourth, reached as relay-b" });
    }
    if (want === "mac") {
      // The laptop must be running: the relay joins its network namespace.
      await this.startRelayContainer("relay", true);
      return (this.relay = {
        mode: "mac",
        url: "ws://127.0.0.1:7447",
        note: "relay in a container that shares the laptop's network namespace (docker --network container:<laptop>), started with no --url and listening on 0.0.0.0:7447. The laptop dials it as ws://127.0.0.1:7447. The devcontainer resolves host.docker.internal to the laptop's address (a network alias on the laptop) and dials ws://host.docker.internal:7447",
      });
    }
    const url = await this.startTunnelRelay();
    return (this.relay = { mode: "tunnel", url, note: "relay process on this machine behind cpart relay --tunnel (cloudflared quick tunnel); the devices reach it over the internet" });
  }

  private relayLog(): number {
    return openSync(join(this.o.work, "relay.log"), "a");
  }

  private spawnHostRelay(extra: string[], host: string): void {
    const fd = this.relayLog();
    const p = spawn(process.execPath, ["packages/cli/src/main.ts", "relay", "--port", String(this.o.port), "--host", host, "--db", join(this.o.work, "relay.db"), ...extra], { stdio: ["ignore", fd, fd], detached: false });
    // It must not outlive this run, however the run ends.
    process.once("exit", () => p.kill("SIGTERM"));
    this.relayProc = p;
  }

  private hostRelayHost = "172.17.0.1";

  private async startHostRelay(): Promise<boolean> {
    // docker0's address: what host-gateway names. Bound there only, never 0.0.0.0.
    const gw = await this.docker(["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]);
    if (gw.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(gw.out.trim())) this.hostRelayHost = gw.out.trim();
    this.spawnHostRelay(["--url", `ws://host.docker.internal:${this.o.port}`], this.hostRelayHost);
    if (!(await this.waitHealthy(`http://${this.hostRelayHost}:${this.o.port}/healthz`, 15_000))) return false;
    // A throwaway container on the same network as the devices.
    const probe = await this.docker(["run", "--rm", "--network", this.net, "--add-host", "host.docker.internal:host-gateway", this.o.image, "node", "-e", `fetch("http://host.docker.internal:${this.o.port}/healthz",{signal:AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`], 60_000);
    return probe.code === 0;
  }

  private stopHostRelay(): void {
    this.relayProc?.kill("SIGTERM");
    this.relayProc = undefined;
  }

  // relay answers to host.docker.internal, relay2 (the spare) to relay-b.
  // inLaptop: in the laptop's network namespace with no --url (mac mode).
  private async startRelayContainer(which: RelayName = "relay", inLaptop = false): Promise<void> {
    const data = this.relayData(which);
    mkdirSync(data, { recursive: true, mode: 0o777 });
    await sh("chmod", ["777", data]);
    const net = inLaptop
      ? ["--network", `container:${this.name("laptop")}`]
      : ["--network", this.net, "--ip", `${this.subnet}.${which === "relay" ? 2 : 3}`, "--network-alias", which === "relay" ? "host.docker.internal" : "relay-b"];
    const url = inLaptop ? [] : ["--url", which === "relay" ? "ws://host.docker.internal:7447" : SPARE_URL];
    await this.must(["run", "-d", "--init", "--name", this.name(which), ...net, "-v", `${data}:/data`, this.o.image, "cpart", "relay", "--host", "0.0.0.0", "--port", "7447", "--db", "/data/relay.db", ...url]);
    const ok = await this.until(30_000, async () => (await this.docker(["exec", this.name(which), "curl", "-sf", "http://127.0.0.1:7447/healthz"])).code === 0);
    if (!ok) throw new Error(`the ${which} container did not answer`);
  }

  relayData(which: RelayName = "relay"): string {
    return join(this.o.work, which === "relay" ? "relay-data" : "relay2-data");
  }

  // The home relay is a container (container and mac modes).
  private inContainer(): boolean {
    return this.relay?.mode === "container" || this.relay?.mode === "mac";
  }

  private async containerRunning(which: RelayName): Promise<boolean> {
    return (await this.docker(["inspect", "-f", "{{.State.Running}}", this.name(which)])).out.trim() === "true";
  }

  private async startTunnelRelay(): Promise<string> {
    const before = existsSync(join(this.o.work, "relay.log")) ? readFileSync(join(this.o.work, "relay.log"), "utf8").length : 0;
    this.spawnHostRelay(["--tunnel"], "127.0.0.1");
    let url = "";
    await this.until(60_000, async () => {
      const m = /relay listening on (wss:\/\/[a-z0-9.-]+trycloudflare\.com)/.exec(readFileSync(join(this.o.work, "relay.log"), "utf8").slice(before));
      if (m) url = m[1]!;
      return !!m;
    });
    if (!url) throw new Error("cpart relay --tunnel gave no address. See relay.log");
    if (!(await this.waitHealthy(`https://${url.slice(6)}/healthz`, 90_000))) throw new Error(`the tunnel address ${url} does not answer`);
    return url;
  }

  private async waitHealthy(url: string, ms: number): Promise<boolean> {
    return this.until(ms, async () => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(4000) })).ok;
      } catch {
        return false;
      }
    });
  }

  async until(ms: number, f: () => Promise<boolean>, every = 1000): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
      if (await f()) return true;
      if (Date.now() > end) return false;
      await sleep(every);
    }
  }

  // hard: SIGKILL, as when the machine it runs on dies.
  async stopRelay(which: RelayName = "relay", hard = false): Promise<void> {
    const mode = this.relay?.mode;
    this.note(`${which} ${hard ? "killed" : "stop"} (${mode})`);
    if (which === "relay2" || this.inContainer()) await this.docker(hard ? ["kill", this.name(which)] : ["stop", "-t", "5", this.name(which)]);
    else {
      const p = this.relayProc;
      this.relayProc = undefined;
      if (p && p.exitCode === null) {
        p.kill(hard ? "SIGKILL" : "SIGTERM");
        await new Promise((r) => p.once("exit", r));
      }
    }
  }

  // Starts it again on the same database. A tunnel comes back at a new address.
  async startRelayAgain(which: RelayName = "relay"): Promise<string> {
    const mode = this.relay!.mode;
    this.note(`${which} start (${mode})`);
    if (which === "relay2" || this.inContainer()) {
      await this.must(["start", this.name(which)]);
      await this.until(30_000, async () => (await this.docker(["exec", this.name(which), "curl", "-sf", "http://127.0.0.1:7447/healthz"])).code === 0);
      return which === "relay2" ? SPARE_URL : this.relay!.url;
    }
    if (mode === "host") {
      this.spawnHostRelay(["--url", `ws://host.docker.internal:${this.o.port}`], this.hostRelayHost);
      await this.waitHealthy(`http://${this.hostRelayHost}:${this.o.port}/healthz`, 15_000);
      return this.relay!.url;
    }
    const url = await this.startTunnelRelay();
    if (url !== this.relay!.url) this.note(`the relay came back at a new address: ${url} (the devices know ${this.relay!.url})`);
    return url;
  }

  relayRunning(): boolean {
    return this.inContainer() ? true : !!this.relayProc && this.relayProc.exitCode === null;
  }

  // In mac mode the laptop answers to host.docker.internal on the devices'
  // network, as a Mac does for its containers.
  private alias(d: Device): string[] {
    return this.o.mode === "mac" && d === "laptop" ? ["host.docker.internal"] : [];
  }

  async startDevice(d: Device): Promise<void> {
    // In container mode the relay container answers to host.docker.internal on this network.
    const host = this.relay?.mode === "host" ? ["--add-host", "host.docker.internal:host-gateway"] : [];
    const args = ["run", "-d", "--init", "--name", this.name(d), "--hostname", d, "--network", this.net, "--ip", this.ip(d), ...this.alias(d).flatMap((a) => ["--network-alias", a]), ...host];
    const cred = this.o.creds[d];
    if (cred) args.push("-v", `${cred}:/home/node/.claude-rig/.credentials.json:ro`);
    args.push(this.o.image);
    await this.must(args);
    this.note(`device ${d} up at ${this.ip(d)}`);
  }

  // Seeds the device's own repository from scripts/devices/repos/<seed>.
  async seedRepo(d: Device, seed: string): Promise<void> {
    const r = await this.exec(d, ["sh", "-c", `cp -r /home/node/seed/${seed}/. /home/node/project/ && cd /home/node/project && git init -q && git add -A && git commit -qm "initial"`]);
    if (r.code !== 0) throw new Error(`seeding ${d}: ${r.err}`);
  }

  // Values in opts.env go through the docker client's environment, not its
  // arguments, so a passphrase does not show in a process listing.
  exec(d: Device, cmd: string[], opts: { env?: Record<string, string>; timeoutMs?: number; cwd?: string; input?: string } = {}): Promise<Run> {
    const env = opts.env ?? {};
    const args = ["exec", "-i", ...(opts.cwd ? ["-w", opts.cwd] : []), ...Object.keys(env).flatMap((k) => ["-e", k]), this.name(d), ...cmd];
    return sh("docker", args, { timeoutMs: opts.timeoutMs ?? 60_000, env: { ...process.env, ...env }, ...(opts.input !== undefined ? { input: opts.input } : {}) });
  }

  cpart(d: Device, args: string[], env: Record<string, string> = {}, timeoutMs = 60_000, cwd?: string): Promise<Run> {
    return this.exec(d, ["cpart", ...args], { env, timeoutMs, ...(cwd ? { cwd } : {}) });
  }

  // cpart in the device on a terminal, with the passphrase typed at its prompt.
  onTerminal(d: Device, args: string[], passphrase: string, timeoutMs = 120_000): Promise<Run> {
    return sh("python3", ["-I", "-c", ON_TERMINAL, "docker", "exec", "-it", this.name(d), "cpart", ...args], { timeoutMs, env: { ...process.env, PTY_ANSWER: passphrase } });
  }

  // Starts a command in the device and returns at once. out() is what it has
  // printed so far, both streams; done resolves with its exit code.
  start(d: Device, cmd: string[], env: Record<string, string> = {}): { out: () => string; done: Promise<number> } {
    const child = spawn("docker", ["exec", "-i", ...Object.keys(env).flatMap((k) => ["-e", k]), this.name(d), ...cmd], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")));
    const done = new Promise<number>((r) => {
      child.on("close", (code) => r(code ?? 1));
      child.on("error", () => r(127));
    });
    process.once("exit", () => child.kill("SIGKILL"));
    return { out: () => out, done };
  }

  async cpartJson<T>(d: Device, args: string[]): Promise<T | undefined> {
    if (this.paused.has(d)) return undefined;
    const r = await this.cpart(d, ["--json", ...args], {}, 30_000);
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.out) as T;
    } catch {
      return undefined;
    }
  }

  isPaused(d: Device): boolean {
    return this.paused.has(d);
  }

  // ---- faults

  async pause(d: Device): Promise<void> {
    await this.must(["pause", this.name(d)]);
    this.paused.add(d);
    this.note(`fault: ${d} asleep (docker pause)`);
  }

  async unpause(d: Device): Promise<void> {
    await this.must(["unpause", this.name(d)]);
    this.paused.delete(d);
    this.note(`fault over: ${d} awake (docker unpause)`);
  }

  async disconnect(d: Device): Promise<void> {
    await this.must(["network", "disconnect", "--force", this.net, this.name(d)]);
    this.offline.add(d);
    this.note(`fault: ${d} off the network (docker network disconnect)`);
  }

  // Back on the network. With a new address unless told otherwise, as after a
  // Wi-Fi drop a laptop often gets one.
  async connect(d: Device, newAddress = true): Promise<void> {
    if (newAddress) this.ips[d] += 1;
    await this.must(["network", "connect", "--ip", this.ip(d), ...this.alias(d).flatMap((a) => ["--alias", a]), this.net, this.name(d)]);
    this.offline.delete(d);
    if (newAddress) this.moved.add(d);
    this.note(`fault over: ${d} back on the network at ${this.ip(d)}`);
  }

  // Undo whatever a scenario left behind, so the next one starts clean.
  async heal(): Promise<string[]> {
    const done: string[] = [];
    for (const d of [...this.paused]) {
      await this.unpause(d);
      done.push(`unpaused ${d}`);
    }
    // At the old address: a new one leaves a link that looks connected and
    // is not, and the next scenario would get the blame.
    for (const d of [...this.offline]) {
      await this.connect(d, false);
      done.push(`reconnected ${d} at its old address`);
    }
    if (this.relay && this.relay.mode !== "container" && !this.relayRunning()) {
      await this.startRelayAgain();
      done.push("started the relay");
    }
    if (this.inContainer() && !(await this.containerRunning("relay"))) {
      await this.startRelayAgain();
      done.push("started the relay");
    }
    if (this.relay?.spare && !(await this.containerRunning("relay2"))) {
      await this.startRelayAgain("relay2");
      done.push("started the spare relay");
    }
    return done;
  }

  // The daemon of d was started again, so its link is new.
  restarted(d: Device): void {
    this.moved.delete(d);
  }

  // The devices that moved and were not restarted since, and forgets them.
  takeMoved(): Device[] {
    const list = [...this.moved];
    this.moved.clear();
    return list;
  }

  // Copies the daemon logs and the relay's out of the containers.
  async collectLogs(): Promise<void> {
    for (const d of DEVICES) {
      const r = await this.docker(["exec", this.name(d), "cat", "/home/node/.cpart/daemon.log"], 30_000);
      if (r.code === 0) writeFileSync(join(this.o.work, `${d}.log`), r.out);
    }
    for (const which of ["relay", "relay2"] as const) {
      if (which === "relay" ? !this.inContainer() : !this.relay?.spare) continue;
      const r = await this.docker(["logs", this.name(which)], 30_000);
      writeFileSync(join(this.o.work, `${which}.log`), r.out + r.err);
    }
  }

  async teardown(): Promise<void> {
    this.stopHostRelay();
    // Names alone do not prove these are ours. Only a run that created its
    // network removes anything.
    if (!this.owned) return;
    for (const d of [...this.paused]) await this.docker(["unpause", this.name(d)]);
    // The relays first: in mac mode one lives in the laptop's network namespace.
    await this.docker(["rm", "-f", this.name("relay"), this.name("relay2")]);
    await this.docker(["rm", "-f", this.name("laptop"), this.name("devcontainer")]);
    await this.docker(["network", "rm", this.net]);
  }
}
