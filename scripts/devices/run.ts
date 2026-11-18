#!/usr/bin/env node
// Runs the two-device scenarios. Started by scripts/devices/rig.sh, which
// builds the image, picks a free port and a work directory, and copies the
// Claude Code login. See scripts/devices/README.md.
//
//   node scripts/devices/run.ts --work DIR --out DIR --image NAME --port N [--mode auto|host|container|tunnel] [--no-sessions] [scenario.json...]
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Device, type Mode, DEVICES, Rig, other, sh, sleep } from "./rig.ts";
import { type ScenarioResult, type SetupResult, writeReport } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    work: { type: "string" }, out: { type: "string" }, image: { type: "string" }, port: { type: "string" }, mode: { type: "string" },
    "no-sessions": { type: "boolean" }, model: { type: "string" }, id: { type: "string" }, laptop: { type: "string" }, devcontainer: { type: "string" }, "login-until": { type: "string" },
  },
});
const WORK = resolve(flags.work ?? "");
const OUT = resolve(flags.out ?? join(WORK, "results"));
const MODEL = flags.model ?? "claude-sonnet-5-5";
// New for each run and kept on this machine, so nothing in a device can learn
// them: an agent that could would approve contracts in its human's place.
const PASSPHRASE: Record<Device, string> = { laptop: randomBytes(18).toString("base64url"), devcontainer: randomBytes(18).toString("base64url") };
// What a session may read: its own repository, the default scope of claude -p.
// The rest is denied outright as well, in case a setting widens that scope:
// the login, the Counterpart home and checkout, and other processes.
const SESSION_DENY = ["/home/node/.claude-rig", "/home/node/.cpart", "/home/node/counterpart", "/home/node/seed", "/proc"].map((p) => `Read(/${p}/**)`);
// The devices' copy of the login has no refresh token, so it stops working
// when the access token expires. No session starts that close to it.
const LOGIN_UNTIL = Number(flags["login-until"] ?? 0);
// Without this a signal ends Node before the exit hook that stops a relay on this machine.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => process.exit(130));
mkdirSync(join(WORK, "sessions"), { recursive: true });
mkdirSync(OUT, { recursive: true });

const say = (s: string): void => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

// ---- scenario files

export interface Step {
  do: string;
  device?: Device;
  [k: string]: unknown;
}
export interface Scenario {
  name: string;
  title: string;
  asker?: Device;
  sessions?: boolean;
  long?: boolean;
  needs?: Mode[];
  steps: Step[];
  file?: string;
}

// ---- what the stores hold

interface Thread {
  id: string;
  contact: string;
  goal: string;
  lastAt: number;
}
interface Ev {
  id: string;
  threadId: string;
  type: string;
  body: Record<string, unknown>;
  mine: boolean;
  status: "applied" | "pending";
  receivedAt: number;
  delivery?: string;
}
interface Contract {
  proposalId: string;
  status: string;
  approvedByMe: boolean;
  approvedByThem: boolean;
  proposedByMe: boolean;
  contract: { title: string };
}

const rig = new Rig({
  work: WORK,
  id: flags.id ?? Math.random().toString(16).slice(2, 8),
  image: flags.image ?? "two-devices:latest",
  mode: (flags.mode ?? "auto") as Mode | "auto",
  port: Number(flags.port ?? 0),
  creds: { ...(flags.laptop ? { laptop: flags.laptop } : {}), ...(flags.devcontainer ? { devcontainer: flags.devcontainer } : {}) },
  log: say,
});

const threads = async (d: Device): Promise<Thread[] | undefined> => rig.cpartJson<Thread[]>(d, ["threads"]);
const log = async (d: Device, thread: string): Promise<Ev[] | undefined> => rig.cpartJson<Ev[]>(d, ["log", "--", thread]);

// ---- one scenario

class Running {
  s: Scenario;
  r: ScenarioResult;
  t0 = Date.now();
  known = new Map<Device, Set<string>>();
  vars: Record<string, string> = {};
  sessions = new Map<string, Promise<void>>();

  constructor(s: Scenario) {
    this.s = s;
    this.r = {
      name: s.name, title: s.title, file: s.file ?? "", ok: true, error: null, startedAt: new Date(this.t0).toISOString(), durationS: 0,
      timeToFirstAnswerS: null, timeToAgreementS: null, interventions: [], restartedByHand: false, lost: { laptopToDevcontainer: 0, devcontainerToLaptop: 0, held: 0, notDelivered: [] },
      faults: [], checks: [], sessions: [], waits: [], reconnects: {}, notes: [], threads: [],
    };
  }

  at(): number {
    return Math.round((Date.now() - this.t0) / 100) / 10;
  }

  fill(text: string): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => this.vars[k] ?? `{{${k}}}`);
  }

  // Threads that did not exist when the scenario started.
  async newThreads(d: Device): Promise<Thread[]> {
    const all = (await threads(d)) ?? [];
    const before = this.known.get(d) ?? new Set();
    return all.filter((t) => !before.has(t.id));
  }

  async scenarioEvents(d: Device): Promise<Ev[]> {
    const out: Ev[] = [];
    for (const t of await this.newThreads(d)) out.push(...((await log(d, t.id)) ?? []));
    return out;
  }

  async restartByHand(why: string, devices: readonly Device[] = DEVICES): Promise<void> {
    for (const d of devices) {
      // What the person would have seen before deciding to restart.
      const st = await rig.cpartJson<{ daemon: { connected: boolean } | null }>(d, ["status"]);
      why += `; ${d}'s cpart status said the daemon was ${st?.daemon ? (st.daemon.connected ? "running and connected" : "running, not connected") : "not running"}`;
      await rig.cpart(d, ["down"]);
      const up = await rig.cpart(d, ["up"]);
      say(`  restarted ${d}'s daemon by hand: ${up.out.trim() || up.err.trim()}`);
    }
    this.r.restartedByHand = true;
    this.r.interventions.push({ by: "rig, for the human", what: `cpart down, then cpart up, on ${devices.join(" and ")}`, why, atS: this.at() });
  }

  async step(st: Step): Promise<void> {
    const d = st.device as Device;
    switch (st.do) {
      case "desk": {
        const contact = (st.contact as string) ?? other(d);
        if (st.on === false) {
          await rig.cpart(d, ["desk", "off", contact]);
          return;
        }
        for (const f of (st.files as string[]) ?? []) {
          const r = await rig.cpart(d, ["bundle", "add", contact, `/home/node/project/${f}`]);
          if (r.code) throw new Error(`bundle add ${f}: ${r.err.trim()}`);
        }
        const r = await rig.cpart(d, ["desk", "on", contact, "--as", (st.as as string) ?? `the ${d} owner`, "--slots", String(st.slots ?? 6), "--daily", "100"]);
        if (r.code) throw new Error(`desk on: ${r.err.trim()}`);
        return;
      }
      case "session": {
        if (flags["no-sessions"]) throw new Error("this scenario needs a live Claude Code session; run without --no-sessions");
        if (LOGIN_UNTIL && LOGIN_UNTIL - Date.now() < (Number(st.timeout ?? 900) + 60) * 1000) throw new Error("the devices' copy of the Claude Code login would run out during this session");
        const id = (st.id as string) ?? `${d}-${this.r.sessions.length + 1}`;
        const p = this.session(d, id, this.fill(st.prompt as string), (st.tools as string[]) ?? [], Number(st.timeout ?? 900));
        if (st.background) this.sessions.set(id, p);
        else await p;
        return;
      }
      case "await": {
        await this.sessions.get(st.id as string);
        return;
      }
      case "capture": {
        // The newest thread this device has with the other one.
        const list = (await this.newThreads(d)).sort((a, b) => b.lastAt - a.lastAt);
        if (!list[0]) throw new Error(`${d} has no new thread to capture`);
        this.vars[(st.var as string) ?? "thread"] = list[0].id;
        return;
      }
      case "wait_message":
        return this.waitMessage(st);
      case "fault":
        return this.fault(st);
      case "sleep":
        await sleep(Number(st.seconds) * 1000);
        return;
      case "cpart": {
        const args = (st.args as string[]).map((a) => this.fill(a));
        const r = await rig.cpart(d, args, st.passphrase ? { CPART_PASSPHRASE: PASSPHRASE[d] } : {}, Number(st.timeout ?? 60) * 1000);
        if (st.human) this.r.interventions.push({ by: "human", what: `${d}: cpart ${args.join(" ")}`, why: (st.why as string) ?? "", atS: this.at() });
        if (r.code !== 0 && st.may_fail !== true) throw new Error(`${d}: cpart ${args.join(" ")} exited ${r.code}: ${r.err.trim() || r.out.trim()}`);
        return;
      }
      case "approve":
        return this.approve(d, st);
      case "expect":
        return this.expect(st);
      default:
        throw new Error(`unknown step "${st.do}" in ${this.s.file}`);
    }
  }

  // A live Claude Code session in the device's repository, with the
  // Counterpart tools that `cpart setup` registered for it and the listed
  // built-in tools. Those are not in --allowedTools: listed bare there, Read
  // would read any file in the device. Left out, it reads the repository only.
  async session(d: Device, id: string, prompt: string, tools: string[], timeoutS: number): Promise<void> {
    const started = Date.now();
    const file = join(WORK, "sessions", `${this.s.name}-${id}.jsonl`);
    say(`  session ${id} on ${d} starts`);
    const r = await rig.exec(
      d,
      ["timeout", String(timeoutS), "claude", "-p", "--model", MODEL, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", tools.join(","), "--allowedTools", "mcp__counterpart__*", "--disallowedTools", ...SESSION_DENY],
      { cwd: "/home/node/project", timeoutMs: (timeoutS + 60) * 1000, input: prompt },
    );
    writeFileSync(file, r.out);
    const calls: string[] = [];
    const toolErrors: string[] = [];
    let text = "";
    let mcp = "not reported";
    let result: { is_error?: boolean; num_turns?: number; total_cost_usd?: number; subtype?: string; result?: string } = {};
    for (const line of r.out.split("\n")) {
      let m: { type?: string; subtype?: string; mcp_servers?: { name: string; status: string }[]; message?: { content?: unknown } } & typeof result;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === "system" && m.subtype === "init") {
        mcp = m.mcp_servers?.find((x) => x.name === "counterpart")?.status ?? "absent";
        const others = (m.mcp_servers ?? []).filter((x) => x.name !== "counterpart").length;
        if (others) mcp += ` (and ${others} other server(s))`;
      }
      if (m.type === "result") result = m;
      const content = Array.isArray(m.message?.content) ? (m.message!.content as { type: string; name?: string; input?: unknown; text?: string; is_error?: boolean; content?: unknown }[]) : [];
      for (const c of content) {
        if (m.type === "assistant" && c.type === "tool_use") calls.push(`${(c.name ?? "").replace("mcp__counterpart__", "")} ${JSON.stringify(c.input).slice(0, 160)}`);
        if (m.type === "assistant" && c.type === "text" && c.text?.trim()) text = c.text.trim();
        if (m.type === "user" && c.type === "tool_result" && c.is_error) toolErrors.push((typeof c.content === "string" ? c.content : JSON.stringify(c.content)).slice(0, 300));
      }
    }
    const rec = {
      id, device: d, startedAtS: Math.round((started - this.t0) / 1000), durationS: Math.round((Date.now() - started) / 1000), exit: r.code, counterpartServer: mcp,
      turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null, isError: result.is_error ?? r.code !== 0, toolCalls: calls, toolErrors, finalText: (result.result ?? text).slice(0, 3000),
      stderr: r.err.trim().slice(-600), transcript: basename(file),
    };
    this.r.sessions.push(rec);
    say(`  session ${id} on ${d} ended after ${rec.durationS}s, exit ${r.code}, ${calls.length} tool calls, counterpart server ${mcp}`);
  }

  // Waits for a message from the other device to land in this device's store.
  async waitMessage(st: Step): Promise<void> {
    const d = st.device as Device;
    const from = other(d);
    const pattern = st.text ? new RegExp(this.fill(st.text as string), "i") : undefined;
    const types = st.type === undefined ? ["talk.posted"] : Array.isArray(st.type) ? (st.type as string[]) : [st.type as string];
    const type = types.join(" or ");
    const since = st.since === "step" ? Date.now() : this.t0;
    const timeout = Number(st.timeout ?? 300);
    const recoverAfter = st.recover_after !== undefined ? Number(st.recover_after) : undefined;
    const label = (st.label as string) ?? `${type} from ${from} on ${d}`;
    const started = Date.now();
    let recovered = false;
    for (;;) {
      if (!rig.isPaused(d)) {
        const evs = await this.scenarioEvents(d);
        const hit = evs.find((e) => !e.mine && e.status === "applied" && types.includes(e.type) && e.receivedAt >= since - 1000 && (!pattern || pattern.test(JSON.stringify(e.body))));
        if (hit) {
          this.r.waits.push({ label, device: d, arrived: true, afterS: Math.max(0, Math.round((hit.receivedAt - started) / 100) / 10), recovered });
          say(`  ${label}: arrived after ${Math.round((Date.now() - started) / 1000)}s`);
          return;
        }
      }
      const waited = (Date.now() - started) / 1000;
      if (recoverAfter !== undefined && !recovered && waited > recoverAfter) {
        recovered = true;
        // The device that is waiting is the one its person would restart.
        await this.restartByHand(`${label} had not arrived ${recoverAfter}s after the wait began`, [(st.restart as Device) ?? d]);
      }
      if (waited > timeout) {
        this.r.waits.push({ label, device: d, arrived: false, afterS: null, recovered });
        if (st.required !== false) throw new Error(`${label}: nothing after ${timeout}s`);
        say(`  ${label}: nothing after ${timeout}s`);
        return;
      }
      await sleep(2000);
    }
  }

  async fault(st: Step): Promise<void> {
    const d = st.device as Device;
    const kind = st.kind as string;
    this.r.faults.push({ kind, device: d ?? null, atS: this.at() });
    if (kind === "pause") return rig.pause(d);
    if (kind === "unpause") return rig.unpause(d);
    if (kind === "disconnect") return rig.disconnect(d);
    if (kind === "connect") return rig.connect(d, st.same_address !== true);
    if (kind === "relay_stop") return rig.stopRelay();
    if (kind === "relay_start" || kind === "relay_restart") {
      if (kind === "relay_restart") {
        await rig.stopRelay();
        await sleep(Number(st.down_seconds ?? 3) * 1000);
      }
      const url = await rig.startRelayAgain();
      if (url !== rig.relay!.url) this.r.notes.push(`The relay came back at ${url}. Both identities still point at ${rig.relay!.url}, and an identity belongs to one relay.`);
      return;
    }
    if (kind === "daemon_down") {
      await rig.cpart(d, ["down"]);
      return;
    }
    throw new Error(`unknown fault "${kind}"`);
  }

  async approve(d: Device, st: Step): Promise<void> {
    const thread = this.fill((st.thread as string) ?? "{{thread}}");
    // The proposal must have reached this side first.
    let pick: Contract | undefined;
    await rig.until(Number(st.timeout ?? 120) * 1000, async () => {
      const list = (await rig.cpartJson<Contract[]>(d, ["contracts", "--", thread])) ?? [];
      const open = list.filter((c) => c.status === "open" || (c.status === "agreed" && c.approvedByMe === false));
      pick = st.proposal && st.proposal !== "latest-open" ? list.find((c) => c.proposalId.startsWith(this.fill(st.proposal as string))) : open.at(-1);
      return !!pick;
    }, 2000);
    if (!pick) throw new Error(`${d} has no open proposal in ${thread} to approve`);
    this.vars.proposal = pick.proposalId;
    const r = await rig.cpart(d, ["approve", "--yes", "--", thread, pick.proposalId], { CPART_PASSPHRASE: PASSPHRASE[d] });
    this.r.interventions.push({ by: "human", what: `${d} approves "${pick.contract.title}" (cpart approve)`, why: "only a human can sign", atS: this.at() });
    if (r.code !== 0) throw new Error(`${d}: cpart approve failed: ${r.err.trim().split("\n").at(-1)}`);
    say(`  ${d} approved ${pick.proposalId.slice(0, 12)} "${pick.contract.title}"`);
  }

  // Checks are recorded, not fatal: a wrong answer is a result, not a crash.
  async expect(st: Step): Promise<void> {
    const name = (st.check as string) ?? "check";
    let pass = false;
    let detail = "";
    if (st.message_matches) {
      // Something the other side sent into this device's scenario threads.
      const d = st.device as Device;
      const texts = (await this.scenarioEvents(d)).filter((e) => !e.mine && e.type === "talk.posted").map((e) => String(e.body.text ?? ""));
      const pats = (st.message_matches as string[]).map((p) => new RegExp(p, "i"));
      pass = texts.some((t) => pats.every((p) => p.test(t)));
      detail = texts.length ? `${texts.length} message(s); first: ${texts[0]!.slice(0, 300)}` : "no messages";
    } else if (st.session_matches) {
      const s = this.r.sessions.find((x) => x.id === st.session);
      const pats = (st.session_matches as string[]).map((p) => new RegExp(p, "i"));
      pass = !!s && pats.every((p) => p.test(s.finalText));
      detail = s ? s.finalText.slice(0, 400) : "no such session";
    } else if (st.agreed) {
      const thread = this.fill((st.thread as string) ?? "{{thread}}");
      const both = await Promise.all(DEVICES.map(async (d) => ((await rig.cpartJson<Contract[]>(d, ["contracts", "--", thread])) ?? []).some((c) => c.status === "agreed")));
      pass = both.every(Boolean);
      detail = `agreed on laptop: ${both[0]}, on devcontainer: ${both[1]}`;
    }
    // For what must not happen, such as a secret reaching the other side.
    if (st.negate === true) pass = !pass;
    this.r.checks.push({ name, pass, detail });
    say(`  check ${name}: ${pass ? "pass" : "FAIL"}`);
  }

  // After the steps: let deliveries finish, then compare the two stores.
  async measure(): Promise<void> {
    const ids = new Set<string>();
    for (const d of DEVICES) for (const t of await this.newThreads(d)) ids.add(t.id);
    this.r.threads = [...ids];
    const diff = async (): Promise<{ a: Ev[]; b: Ev[]; lost: { from: Device; e: Ev }[]; held: number }> => {
      const a: Ev[] = [];
      const b: Ev[] = [];
      for (const id of ids) {
        a.push(...((await log("laptop", id)) ?? []));
        b.push(...((await log("devcontainer", id)) ?? []));
      }
      const has = (list: Ev[], id: string): boolean => list.some((e) => e.id === id && e.status === "applied");
      const lost = [...a.filter((e) => e.mine && !has(b, e.id)).map((e) => ({ from: "laptop" as Device, e })), ...b.filter((e) => e.mine && !has(a, e.id)).map((e) => ({ from: "devcontainer" as Device, e }))];
      return { a, b, lost, held: [...a, ...b].filter((e) => e.status === "pending").length };
    };
    let now = await diff();
    const settle = Date.now();
    while ((now.lost.length || now.held) && Date.now() - settle < 90_000) {
      await sleep(3000);
      now = await diff();
    }
    this.r.lost = {
      laptopToDevcontainer: now.lost.filter((x) => x.from === "laptop").length,
      devcontainerToLaptop: now.lost.filter((x) => x.from === "devcontainer").length,
      held: now.held,
      notDelivered: now.lost.map((x) => `${x.from}: ${x.e.type} ${x.e.id.slice(0, 10)} (${x.e.delivery ?? "?"})`),
    };
    // Time to first answer, read from the asker's own store and clock.
    const asker = this.s.asker;
    if (asker) {
      const evs = asker === "laptop" ? now.a : now.b;
      // The question may be the thread's goal, with no message after it.
      const q = evs.filter((e) => e.mine && (e.type === "talk.posted" || e.type === "thread.opened")).sort((x, y) => x.receivedAt - y.receivedAt)[0];
      const ans = q && evs.filter((e) => !e.mine && e.status === "applied" && e.type === "talk.posted" && e.threadId === q.threadId && e.receivedAt >= q.receivedAt).sort((x, y) => x.receivedAt - y.receivedAt)[0];
      if (q && ans) this.r.timeToFirstAnswerS = Math.round((ans.receivedAt - q.receivedAt) / 100) / 10;
    }
    const opened = now.a.filter((e) => e.type === "thread.opened").map((e) => e.receivedAt);
    const accepts = now.a.filter((e) => e.type === "contract.accepted").map((e) => e.receivedAt);
    if (accepts.length >= 2 && opened.length) this.r.timeToAgreementS = Math.round((Math.max(...accepts) - Math.min(...opened)) / 1000);
  }

  // Each daemon must be running and connected when the scenario ends.
  async afterwards(): Promise<void> {
    for (const d of DEVICES) {
      const ok = await rig.until(60_000, async () => !!(await rig.cpartJson<{ daemon: { connected: boolean } | null }>(d, ["status"]))?.daemon?.connected, 2000);
      if (!ok) await this.restartByHand(`${d}'s daemon was not running and connected 60s after the scenario's last step`, [d]);
    }
  }
}

async function daemonLogLines(): Promise<Record<Device, number>> {
  const n = {} as Record<Device, number>;
  for (const d of DEVICES) n[d] = Number((await rig.exec(d, ["sh", "-c", "wc -l < /home/node/.cpart/daemon.log"])).out.trim() || 0);
  return n;
}

async function daemonLogSince(d: Device, from: number): Promise<string[]> {
  const r = await rig.exec(d, ["sh", "-c", `tail -n +${from + 1} /home/node/.cpart/daemon.log`]);
  return r.out.split("\n").filter(Boolean);
}

async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const run = new Running(s);
  for (const d of DEVICES) run.known.set(d, new Set(((await threads(d)) ?? []).map((t) => t.id)));
  const lines = await daemonLogLines();
  run.t0 = Date.now();
  run.r.startedAt = new Date(run.t0).toISOString();
  say(`== ${s.name}: ${s.title}`);
  try {
    for (const st of s.steps) {
      say(` - ${st.do}${st.device ? ` ${st.device}` : ""}${st.kind ? ` ${st.kind}` : ""}${st.label ? ` (${st.label})` : ""}`);
      await run.step(st);
    }
    await Promise.all(run.sessions.values());
  } catch (e) {
    run.r.ok = false;
    run.r.error = (e as Error).message;
    say(`  FAILED: ${run.r.error}`);
    // A session left running would keep talking into the next scenario. Only
    // the rig's own sessions match; the front desk runs claude differently.
    await rig.heal();
    for (const d of DEVICES) await rig.exec(d, ["pkill", "-f", "allowedTools mcp__counterpart"]);
    await Promise.race([Promise.all(run.sessions.values()), sleep(30_000)]);
  }
  const healed = await rig.heal();
  if (healed.length) run.r.notes.push(`after the steps the rig undid: ${healed.join(", ")}`);
  await run.afterwards();
  await run.measure();
  for (const d of DEVICES) {
    const l = await daemonLogSince(d, lines[d]);
    run.r.reconnects[d] = { lost: l.filter((x) => x.startsWith("relay connection lost")).length, connected: l.filter((x) => x.startsWith("connected")).length, errors: l.filter((x) => /^error|front desk: /.test(x)).slice(0, 8) };
  }
  if (run.r.checks.some((c) => !c.pass)) run.r.ok = false;
  if (run.r.lost.laptopToDevcontainer || run.r.lost.devcontainerToLaptop) run.r.ok = false;
  // Getting there only after a restart by hand, or not at all, is not the smooth path.
  if (run.r.restartedByHand || run.r.waits.some((w) => !w.arrived)) run.r.ok = false;
  run.r.durationS = Math.round((Date.now() - run.t0) / 1000);
  say(`== ${s.name}: ${run.r.ok ? "ok" : "NOT OK"} in ${run.r.durationS}s; first answer ${run.r.timeToFirstAnswerS ?? "-"}s; interventions ${run.r.interventions.length}; lost ${run.r.lost.laptopToDevcontainer + run.r.lost.devcontainerToLaptop}; restarted by hand: ${run.r.restartedByHand ? "yes" : "no"}`);
  return run.r;
}

// ---- pairing, the way two people would do it

async function setup(res: SetupResult): Promise<SetupResult> {
  const t0 = Date.now();
  const url = rig.relay!.url;
  const s1 = await rig.cpart("laptop", ["setup", "--relay", url], { CPART_PASSPHRASE: PASSPHRASE.laptop }, 120_000);
  res.laptop = (s1.out + s1.err).trim();
  if (s1.code !== 0) throw new Error(`laptop: cpart setup failed: ${res.laptop}`);
  const inv = await rig.cpart("laptop", ["invite", "devcontainer"]);
  const invite = /cpart-invite:[A-Za-z0-9_-]+/.exec(inv.out)?.[0];
  if (!invite) throw new Error(`laptop: no invite in: ${inv.out}${inv.err}`);
  // First as a person would type it. It asks before using a relay on a private address.
  let j = await rig.cpart("devcontainer", ["join", invite, "laptop"], { CPART_PASSPHRASE: PASSPHRASE.devcontainer }, 120_000);
  if (j.code !== 0 && /this needs a terminal|Type yes/.test(j.err + j.out)) {
    res.interventions.push({ by: "human", what: "devcontainer: typed yes to use a relay on a private address (cpart join ... --yes)", why: `join asks before it uses a relay on a private address; without a terminal it said: ${(j.err + j.out).trim().split("\n")[0]!.slice(0, 200)}`, atS: Math.round((Date.now() - t0) / 1000) });
    j = await rig.cpart("devcontainer", ["join", invite, "laptop", "--yes"], { CPART_PASSPHRASE: PASSPHRASE.devcontainer }, 120_000);
  }
  res.devcontainer = (j.out + j.err).trim();
  if (j.code !== 0) throw new Error(`devcontainer: cpart join failed: ${res.devcontainer}`);
  const paired = await rig.until(60_000, async () => {
    const a = await rig.cpartJson<{ state: string; safetyCode: string }[]>("laptop", ["contacts"]);
    const b = await rig.cpartJson<{ state: string; safetyCode: string }[]>("devcontainer", ["contacts"]);
    if (a?.[0]?.state === "active" && b?.[0]?.state === "active") {
      res.safetyCodesMatch = a[0].safetyCode === b[0].safetyCode;
      return true;
    }
    return false;
  });
  if (!paired) throw new Error("the two devices did not finish pairing in 60s");
  const pairedAt = Date.now();
  // The daemons that setup and join started inherited CPART_PASSPHRASE, and a
  // session runs as the same user. Start them again without it.
  for (const d of DEVICES) {
    await rig.cpart(d, ["down"]);
    const up = await rig.cpart(d, ["up"]);
    if (up.code !== 0) throw new Error(`${d}: cpart up failed: ${(up.err || up.out).trim()}`);
    const left = await rig.exec(d, ["sh", "-c", "grep -ls CPART_PASSPHRASE= /proc/[0-9]*/environ || true"]);
    if (left.out.trim()) throw new Error(`${d}: a process still holds CPART_PASSPHRASE: ${left.out.trim()}`);
  }
  const connected = await rig.until(60_000, async () => {
    for (const d of DEVICES) if (!(await rig.cpartJson<{ daemon: { connected: boolean } | null }>(d, ["status"]))?.daemon?.connected) return false;
    return true;
  }, 2000);
  if (!connected) throw new Error("the daemons did not connect again in 60s after the restart that drops the passphrase");
  for (const d of DEVICES) {
    const st = await rig.cpartJson<{ agents: { name: string; found: boolean; registered: string }[] }>(d, ["status"]);
    res.agentsRegistered[d] = st?.agents.filter((a) => a.found).map((a) => `${a.name}: ${a.registered}`).join(", ") ?? "unknown";
  }
  res.ok = true;
  res.durationS = Math.round((pairedAt - t0) / 1000);
  return res;
}

function loadScenarios(): Scenario[] {
  const dir = join(HERE, "scenarios");
  const files = positionals.length ? positionals.map((p) => resolve(p)) : readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f));
  const all = files.map((f) => ({ ...(JSON.parse(readFileSync(f, "utf8")) as Scenario), file: `scripts/devices/scenarios/${basename(f)}` }));
  // A long scenario runs only when named.
  return positionals.length ? all : all.filter((s) => !s.long);
}

async function main(): Promise<void> {
  const scenarios = loadScenarios();
  const started = new Date().toISOString();
  const results: ScenarioResult[] = [];
  let setupResult: SetupResult | undefined;
  let fatal: string | null = null;
  const claudeVersion = (await sh("docker", ["run", "--rm", rig.o.image, "claude", "--version"], { timeoutMs: 60_000 })).out.trim();
  try {
    await rig.createNetwork();
    const relay = await rig.startRelay();
    say(`relay: ${relay.url} (${relay.mode})`);
    for (const d of DEVICES) await rig.startDevice(d);
    await rig.seedRepo("laptop", "provider");
    await rig.seedRepo("devcontainer", "client");
    setupResult = { ok: false, durationS: 0, interventions: [], laptop: "", devcontainer: "", safetyCodesMatch: false, agentsRegistered: {}, error: null };
    await setup(setupResult).catch((e: Error) => {
      setupResult!.error = e.message;
      throw e;
    });
    say(`paired in ${setupResult.durationS}s; safety codes match: ${setupResult.safetyCodesMatch}`);
    for (const s of scenarios) {
      if (s.needs && !s.needs.includes(relay.mode)) {
        say(`== ${s.name}: skipped, needs relay mode ${s.needs.join(" or ")}`);
        continue;
      }
      if (s.sessions !== false && flags["no-sessions"]) {
        say(`== ${s.name}: skipped, needs live sessions`);
        continue;
      }
      results.push(await runScenario(s));
    }
  } catch (e) {
    fatal = (e as Error).message;
    say(`FATAL: ${fatal}`);
  } finally {
    await rig.collectLogs().catch(() => undefined);
    writeReport(OUT, { startedAt: started, finishedAt: new Date().toISOString(), relay: rig.relay ?? null, model: MODEL, claudeVersion, image: rig.o.image, host: process.platform, setup: setupResult ?? null, scenarios: results, fatal });
    await rig.teardown();
  }
  say(`results in ${OUT}`);
  if (fatal) process.exit(2);
}

void main();
