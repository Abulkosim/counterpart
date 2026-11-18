// The results of one rig run: results.json for machines, report.md for people.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayInfo } from "./rig.ts";

export interface Intervention {
  by: "human" | "rig, for the human";
  what: string;
  why: string;
  atS: number;
}

export interface SessionRecord {
  id: string;
  device: string;
  startedAtS: number;
  durationS: number;
  exit: number;
  counterpartServer: string;
  turns: number | null;
  costUsd: number | null;
  isError: boolean;
  toolCalls: string[];
  toolErrors: string[];
  finalText: string;
  stderr: string;
  transcript: string;
}

export interface ScenarioResult {
  name: string;
  title: string;
  file: string;
  ok: boolean;
  error: string | null;
  startedAt: string;
  durationS: number;
  timeToFirstAnswerS: number | null;
  timeToAgreementS: number | null;
  interventions: Intervention[];
  restartedByHand: boolean;
  lost: { laptopToDevcontainer: number; devcontainerToLaptop: number; held: number; notDelivered: string[] };
  faults: { kind: string; device: string | null; atS: number }[];
  checks: { name: string; pass: boolean; detail: string }[];
  sessions: SessionRecord[];
  waits: { label: string; device: string; arrived: boolean; afterS: number | null; recovered: boolean }[];
  reconnects: Record<string, { lost: number; connected: number; errors: string[] }>;
  notes: string[];
  threads: string[];
}

export interface SetupResult {
  ok: boolean;
  durationS: number;
  interventions: Intervention[];
  laptop: string;
  devcontainer: string;
  safetyCodesMatch: boolean;
  agentsRegistered: Record<string, string>;
  error: string | null;
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  relay: RelayInfo | null;
  model: string;
  claudeVersion: string;
  image: string;
  host: string;
  setup: SetupResult | null;
  scenarios: ScenarioResult[];
  fatal: string | null;
}

// ok: done with no help. A restart by hand that got it through is told apart from a failure.
export const verdict = (s: ScenarioResult): string =>
  s.ok ? "ok"
  : s.error || s.checks.some((c) => !c.pass) || s.waits.some((w) => !w.arrived) || s.lost.laptopToDevcontainer + s.lost.devcontainerToLaptop ? "**failed**"
  : "**needed a restart**";

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function writeReport(dir: string, r: RunResult): void {
  writeFileSync(join(dir, "results.json"), `${JSON.stringify(r, null, 2)}\n`);
  const lines = [
    `# Two-device run, ${r.startedAt.slice(0, 16).replace("T", " ")} UTC`,
    "",
    `Relay: ${r.relay ? `${r.relay.mode}, ${r.relay.note}` : "never started"}. Model ${r.model}, ${r.claudeVersion || "Claude Code version unknown"}. Both devices are Docker containers on one Linux host.`,
    "",
  ];
  if (r.fatal) lines.push(`**The run stopped early:** ${cell(r.fatal)}`, "");
  if (r.setup) {
    lines.push(
      `Setup: \`cpart setup\` on the laptop, \`cpart join\` on the devcontainer, paired in ${r.setup.durationS}s. Safety codes ${r.setup.safetyCodesMatch ? "match" : "DIFFER"}. Agents: laptop ${r.setup.agentsRegistered.laptop ?? "?"}; devcontainer ${r.setup.agentsRegistered.devcontainer ?? "?"}.`,
      ...r.setup.interventions.map((i) => `- Human step during setup: ${cell(i.what)}. ${cell(i.why)}`),
      "",
      ...(r.setup.ok ? [] : ["What setup printed on the laptop:", "", "```", r.setup.laptop, "```", "", "On the devcontainer:", "", "```", r.setup.devcontainer, "```", ""]),
    );
  }
  lines.push("| Scenario | Result | First answer | Agreement | Human steps | Lost | Restarted by hand | Took |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of r.scenarios) {
    const lost = s.lost.laptopToDevcontainer + s.lost.devcontainerToLaptop;
    lines.push(
      `| ${s.name} | ${verdict(s)} | ${s.timeToFirstAnswerS === null ? "none" : `${s.timeToFirstAnswerS}s`} | ${s.timeToAgreementS === null ? "-" : `${s.timeToAgreementS}s`} | ${s.interventions.length} | ${lost}${s.lost.held ? ` (+${s.lost.held} held)` : ""} | ${s.restartedByHand ? "yes" : "no"} | ${s.durationS}s |`,
    );
  }
  lines.push("", "First answer: from the asker's first message or thread goal, whichever came first, to the first reply in that thread, both read from the asker's store and clock. Lost: messages one store holds as sent and the other never applied, after up to 90 seconds to settle. Human steps include approvals, which are meant to be human.", "");
  for (const s of r.scenarios) {
    lines.push(`## ${s.name}: ${s.title}`, "", `\`${s.file}\`. ${s.ok ? "Ended as expected." : `**Did not end as expected.**${s.error ? ` ${cell(s.error)}` : ""}`}`, "");
    if (s.faults.length) lines.push(`Faults: ${s.faults.map((f) => `${f.kind}${f.device ? ` ${f.device}` : ""} at ${f.atS}s`).join("; ")}.`, "");
    for (const w of s.waits) lines.push(`- Waited for ${cell(w.label)}: ${w.arrived ? `arrived after ${w.afterS}s` : "never arrived"}${w.recovered ? ", after the rig restarted the daemons" : ""}.`);
    for (const c of s.checks) lines.push(`- Check ${c.name}: ${c.pass ? "pass" : "**fail**"}. ${cell(c.detail.slice(0, 300))}`);
    for (const i of s.interventions) lines.push(`- ${i.by === "human" ? "Human step" : "**Restart by hand**"} at ${i.atS}s: ${cell(i.what)}${i.why ? `. Why: ${cell(i.why)}` : ""}`);
    for (const [d, c] of Object.entries(s.reconnects)) if (c.lost || c.errors.length) lines.push(`- ${d} daemon log: ${c.lost} lost connection(s), ${c.connected} (re)connect(s)${c.errors.length ? `; ${c.errors.map(cell).join("; ")}` : ""}.`);
    if (s.lost.notDelivered.length) lines.push(`- Not delivered: ${s.lost.notDelivered.join(", ")}.`);
    for (const n of s.notes) lines.push(`- ${cell(n)}`);
    for (const x of s.sessions) {
      lines.push(
        "",
        `Session \`${x.id}\` on ${x.device}: ${x.durationS}s, ${x.turns ?? "?"} turns, exit ${x.exit}${x.isError ? " (error)" : ""}, counterpart server ${x.counterpartServer}. Tool calls: ${x.toolCalls.map((c) => c.split(" ")[0]).join(", ") || "none"}.${x.toolErrors.length ? ` Tool errors: ${x.toolErrors.map((e) => cell(e.slice(0, 160))).join("; ")}.` : ""}`,
        "",
        ...x.finalText.split("\n").slice(0, 14).map((l) => `> ${l}`),
      );
    }
    lines.push("");
  }
  writeFileSync(join(dir, "report.md"), `${lines.join("\n")}\n`);
}
