// Prints how the outbound guard does on its corpus: ordinary messages held by
// mistake, and secrets it failed to hold. See docs/guard.md.
//
//   node scripts/guard-measure.ts [--verbose]
//
// Needs node 24 only. No model, no network. 16 s on a shared 2-core machine.

import { measure } from "../packages/daemon/test/guard-corpus/measure.ts";

const verbose = process.argv.includes("--verbose");
const r = measure();
const pct = (a: number, b: number): string => `${((100 * a) / Math.max(b, 1)).toFixed(2)}%`;

console.log(`Ordinary messages: ${r.ordinary.total}, held by mistake ${r.ordinary.held.length} (${pct(r.ordinary.held.length, r.ordinary.total)})`);
for (const [s, v] of Object.entries(r.ordinary.bySource)) console.log(`  ${s.padEnd(10)} ${String(v.total).padStart(4)} messages, ${v.held} held`);
for (const h of r.ordinary.held) {
  console.log(`  HELD (${h.source}): ${h.findings.map((f) => `${f.category}/${f.rule}/${f.how}`).join(", ")}`);
  if (verbose) console.log(`    ${JSON.stringify(h.text).slice(0, 400)}`);
}
console.log(`Planted secrets and encodings: ${r.planted.total}, held ${r.planted.total - r.planted.missed.length} (${pct(r.planted.total - r.planted.missed.length, r.planted.total)})`);
for (const m of r.planted.missed) console.log(`  MISSED ${m}`);
console.log(`gitleaks true positives: ${r.gitleaks.tps} from ${r.gitleaks.rules} rules, held ${r.gitleaks.caught} (${pct(r.gitleaks.caught, r.gitleaks.tps)})`);
const byRule = new Map<string, number>();
for (const m of r.gitleaks.missed) byRule.set(m.rule, (byRule.get(m.rule) ?? 0) + 1);
for (const [rule, n] of byRule) {
  console.log(`  MISSED ${n} of rule ${rule}`);
  if (verbose) for (const m of r.gitleaks.missed.filter((x) => x.rule === rule).slice(0, 3)) console.log(`    ${JSON.stringify(m.text).slice(0, 300)}`);
}
console.log(`gitleaks false positives (strings each rule must not match): ${r.gitleaks.fps}, held by some check ${r.gitleaks.fpsHeld} (${pct(r.gitleaks.fpsHeld, r.gitleaks.fps)})`);
console.log(`Took ${r.ms} ms`);
