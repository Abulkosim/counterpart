// cpart desk on and cpart desk check: before the front desk is turned on, ask
// the daemon to make one tiny model call with its own environment. A daemon
// started at login, by systemd or launchd, or in a fresh container does not
// have the shell's PATH or CLAUDE_CONFIG_DIR, so a check from this shell
// would prove nothing.
import { type CheckResult, CHECK_TIMEOUT_MS, type FrontDesk, type ModelSetup } from "@counterpart/frontdesk";

export interface CheckIo {
  daemon: () => Promise<boolean>; // true when a daemon holds this home, starting one if allowed
  boot: () => string | undefined; // "systemd" or "launchd" when it starts at login
  log: string; // the daemon's log file
  safe: (s: string) => string;
  wait?: { pickupMs?: number; pollMs?: number };
}

// "failed": the model could not run. "no-daemon": nothing was checked.
// "no-answer": the daemon did not take the check or did not finish it.
export type DeskCheck = { ok: true; setup: ModelSetup | null } | { ok: false; kind: "failed" | "no-daemon" | "no-answer"; text: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function deskCheck(desk: FrontDesk, io: CheckIo): Promise<DeskCheck> {
  if (!(await io.daemon())) return { ok: false, kind: "no-daemon", text: "The daemon is not running, so the front desk's model was not checked. The desk answers only while the daemon runs. Start it: cpart up. Then check the model: cpart desk check" };
  const id = desk.requestCheck();
  const pickupMs = io.wait?.pickupMs ?? 15_000;
  let pickup = Date.now() + pickupMs;
  let end: number | null = null;
  for (;;) {
    const r = desk.checkResult(id);
    if (typeof r === "object") return r.ok ? { ok: true, setup: r.setup } : { ok: false, kind: "failed", text: explain(r, io) };
    if (r === "waiting") {
      // The daemon runs one check at a time. While it runs one asked for
      // elsewhere, this one waits its turn; that is not a daemon that ignores it.
      if (desk.checkBusy()) pickup = Date.now() + pickupMs;
      else if (Date.now() > pickup) {
        desk.cancelCheck(id);
        return { ok: false, kind: "no-answer", text: "The daemon did not take the check. If it started before cpart was updated, restart it: cpart down, then cpart up" };
      }
    } else {
      end ??= Date.now() + CHECK_TIMEOUT_MS + 30_000;
      if (Date.now() > end) return { ok: false, kind: "no-answer", text: `The daemon took the check but did not finish it. See the daemon's log: ${io.safe(io.log)}` };
    }
    await sleep(io.wait?.pollMs ?? 200);
  }
}

// The command that does what `cpart desk on` was asked to do, without the
// check. It keeps --as, --slots and --daily: without them a first desk would
// answer as "the owner" with the default limits. The owner name is 1-40
// letters, digits, spaces, dots, dashes and underscores, so single quotes hold it.
export function onAnyway(contact: string, opts: { as?: string | undefined; slots?: string | undefined; daily?: string | undefined }, wasOn: boolean): string {
  const q = (s: string): string => (/^[\w.-]+$/.test(s) ? s : `'${s}'`);
  const cmd = ["cpart desk on", q(contact), ...(opts.as ? ["--as", q(opts.as)] : []), ...(opts.slots ? ["--slots", q(opts.slots)] : []), ...(opts.daily ? ["--daily", q(opts.daily)] : []), "--no-check"].join(" ");
  return wasOn ? `Nothing was changed. The desk is still on as before. To make the change anyway: ${cmd}` : `Nothing was changed. To turn the desk on anyway: ${cmd}`;
}

// What failed, where the daemon looked, and what to do about it.
export function explain(r: CheckResult, io: Pick<CheckIo, "boot" | "safe">): string {
  const s = io.safe;
  const lines = [`The front desk's model cannot run from the daemon: ${s(r.detail ?? r.short ?? "unknown error")}`];
  const setup = r.setup;
  const restart = io.boot() ? "cpart down, then cpart up --boot (it starts at login with the environment it had when you ran cpart up --boot)" : "cpart down, then cpart up, from a shell where it works";
  if (setup?.kind === "claude-cli") {
    const config = setup.configDir ?? setup.defaultConfigDir;
    lines.push(
      "The daemon runs:",
      `  claude      ${setup.found ? s(setup.found) : `not found (it looks for "${s(setup.bin)}" on PATH)`}`,
      `  PATH        ${s(setup.path) || "(empty)"}`,
      `  config      ${s(config)}${setup.configDir ? " (CLAUDE_CONFIG_DIR)" : " (CLAUDE_CONFIG_DIR not set)"}`,
    );
    const shellConfig = process.env.CLAUDE_CONFIG_DIR ?? null;
    if (!setup.found) lines.push(`Fix: put claude on the daemon's PATH, then restart the daemon: ${restart}.`);
    else if (r.short === "claude is not logged in") {
      if (shellConfig !== setup.configDir) lines.push(`This shell has ${shellConfig ? `CLAUDE_CONFIG_DIR=${s(shellConfig)}` : "no CLAUDE_CONFIG_DIR"}; the daemon has ${setup.configDir ? `CLAUDE_CONFIG_DIR=${s(setup.configDir)}` : "none"}. If claude is logged in here, restart the daemon: ${restart}.`);
      lines.push(`Fix: log claude in for the daemon's config: ${setup.configDir ? `CLAUDE_CONFIG_DIR=${s(setup.configDir)} ` : ""}claude auth login`);
    } else lines.push(`Fix: run the same claude yourself to see what is wrong: ${setup.configDir ? `CLAUDE_CONFIG_DIR=${s(setup.configDir)} ` : ""}${s(setup.found)} -p ok`);
    lines.push("Or give the daemon ANTHROPIC_API_KEY instead, and restart it.");
  } else if (setup?.kind === "api") {
    lines.push(`The daemon calls the Messages API at ${s(setup.baseUrl)} with the ANTHROPIC_API_KEY it was started with.`, `Fix the key, then restart the daemon: ${restart}.`);
  }
  return lines.join("\n");
}
