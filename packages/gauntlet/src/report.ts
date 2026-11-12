import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cases, modelCases, problems } from "./catalogue.ts";
import { REPO } from "./harness.ts";
import { type Outcome, type Status, runAll } from "./run.ts";
import { CATEGORIES, type Category } from "./types.ts";

const WORD: Record<Status, string> = { held: "held", open: "**open finding**", failed: "**FAILED**", fixed: "**fixed, marker not removed**" };
const RANK = { high: 0, medium: 1, low: 2 } as const;
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const count = (list: Outcome[], s: Status): number => list.filter((o) => o.status === s).length;

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function render(outcomes: Outcome[], commit: string, date: string): string {
  const open = outcomes.filter((o) => o.status === "open").sort((a, b) => RANK[a.case.finding!.severity] - RANK[b.case.finding!.severity]);
  const bad = outcomes.filter((o) => o.status === "failed" || o.status === "fixed");
  const l: string[] = [];
  l.push("# Gauntlet", "");
  l.push(
    "Counterpart says its security comes from code that limits what can happen, not from asking a model to behave. This is the test of that. " +
      "Each case below is an attack run against the real code: the protocol library, the relay, the daemon and the `cpart` CLI. " +
      "The attacker is a stranger, one of your contacts, the relay, or someone on the network.",
    "",
    "A case states one rule and tries to break it. \"Held\" means the attack was refused and the test confirmed nothing else changed. " +
      "\"Open finding\" means the attack worked and the defect is not fixed yet. Open findings stay in the suite and are listed first, with the attack and a suggested fix.",
    "",
    "This file is generated. Run `pnpm gauntlet` to rebuild it. The same cases run in `pnpm test` on every commit. The cases live in `packages/gauntlet/src/cases`.",
    "",
  );

  l.push("## Totals", "", "| Category | Cases | Held | Open findings | Failed |", "| --- | ---: | ---: | ---: | ---: |");
  for (const [key, name] of Object.entries(CATEGORIES)) {
    const list = outcomes.filter((o) => o.case.category === key);
    l.push(`| ${name} | ${list.length} | ${count(list, "held")} | ${count(list, "open")} | ${count(list, "failed") + count(list, "fixed")} |`);
  }
  l.push(`| **All** | **${outcomes.length}** | **${count(outcomes, "held")}** | **${count(outcomes, "open")}** | **${bad.length}** |`, "");

  if (bad.length) {
    l.push("## Needs attention", "");
    for (const o of bad) {
      l.push(o.status === "fixed" ? `- ${o.case.id} is marked as a known failure but passes now. Remove its \`knownFailure\` and \`finding\`.` : `- ${o.case.id} failed and is not a known finding: ${cell(o.error?.message ?? "")}`);
    }
    l.push("");
  }

  l.push("## Open findings", "");
  if (!open.length) l.push("None.", "");
  else l.push("Most severe first. Each is demonstrated by the case with the same id in the tables below.", "");
  for (const o of open) {
    const { case: c } = o;
    const f = c.finding!;
    l.push(`### ${c.id}: ${c.title} (${f.severity})`, "");
    l.push(`- **Rule that should hold:** ${c.claim}`);
    l.push(`- **Who can do it:** ${c.attacker}`);
    l.push(`- **What is wrong:** ${c.knownFailure}.`);
    l.push(`- **Attack:** ${f.scenario}`);
    l.push(`- **Where:** \`${f.where}\``);
    l.push(`- **Suggested fix:** ${f.fix}`, "");
  }

  l.push("## Code-enforced rules", "", "These are guarantees. A case here either holds or it does not.", "");
  for (const [key, name] of Object.entries(CATEGORIES) as [Category, string][]) {
    const list = outcomes.filter((o) => o.case.category === key);
    if (!list.length) continue;
    l.push(`### ${name}`, "", "| Case | Who attacks | The rule | Result |", "| --- | --- | --- | --- |");
    for (const o of list) l.push(`| ${o.case.id} ${cell(o.case.title)} | ${o.case.attacker} | ${cell(o.case.claim)} | ${WORD[o.status]} |`);
    l.push("");
  }

  l.push("## Model behaviour", "");
  l.push(
    "Not measured yet. This section is for attacks on the model that reads peer text (the front desk). " +
      "Those results will be reported here as rates over repeated trials, separately from the tables above, because they are measurements and not guarantees. " +
      "The slot is `packages/gauntlet/src/cases/model.ts`.",
    "",
  );
  if (modelCases.length) l.push(`${modelCases.length} model cases are defined but this report does not run them yet.`, "");

  l.push("## What this does not cover", "");
  l.push(
    "- Timing: the relay's ten second login timeout, sweeping of expired mail, and reconnect backoff are not exercised.",
    "- Two machines, real networks, TLS. Everything runs in one process or over loopback.",
    "- The cryptographic primitives themselves. HPKE and Ed25519 are used as given.",
    "- Crashes in the middle of a write, and several processes sharing one identity directory.",
    "- Faking a log line by padding a message with spaces until the terminal wraps.",
    "- How much an accepted contact can make you store. Nothing caps the threads, messages or contact.hello events an active contact sends.",
    "- A relay that says it stored a message and then drops it. The design accepts that the relay can lose mail.",
    "- macOS and Windows.",
    "",
  );
  l.push("---", "", `Generated from commit \`${commit}\` on ${date} (UTC), Node ${process.version}.`, "");
  return l.join("\n");
}

// `node report.ts` runs everything and writes the report. With case ids as
// arguments it runs only those, prints why each one failed, and writes nothing.
async function main(): Promise<void> {
  const wrong = problems();
  if (wrong.length) throw new Error(`catalogue: ${wrong.join("; ")}`);
  const only = process.argv.slice(2);
  const list = only.length ? cases.filter((c) => only.some((id) => c.id.startsWith(id))) : cases;
  const outcomes = await runAll(list, (o) => {
    const why = o.error && (only.length || o.status === "failed") ? `\n         ${o.error.message.split("\n").slice(0, 6).join("\n         ")}` : "";
    console.log(`${o.status.padEnd(6)} ${String(o.ms).padStart(5)} ms  ${o.case.id} ${o.case.title}${why}`);
  });
  const bad = outcomes.filter((o) => o.status === "failed" || o.status === "fixed");
  console.log(`\n${outcomes.length} cases: ${count(outcomes, "held")} held, ${count(outcomes, "open")} open findings, ${bad.length} need attention.`);
  if (bad.length) process.exitCode = 1;
  if (only.length) return;
  const dirty = git("status", "--porcelain", "--", ".", ":!docs/gauntlet.md") !== "";
  const commit = (git("rev-parse", "--short", "HEAD") || "unknown") + (dirty ? " plus uncommitted changes" : "");
  const out = join(REPO, "docs/gauntlet.md");
  writeFileSync(out, render(outcomes, commit, new Date().toISOString().slice(0, 10)));
  console.log(`Wrote ${out}`);
}

if (import.meta.main) await main();
