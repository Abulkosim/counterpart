// Runs the guard's scanner over the corpus: ordinary messages that must pass,
// and secrets that must be held. Used by the tests and by scripts/guard-measure.ts.

import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Finding, type Secrets, dotenvFiles, dotenvValues, envValues, fieldsOf, neverShare, scan } from "../../src/guard.ts";
import { ENV, catchCases, plantFiles } from "./planted.ts";

const HERE = import.meta.dirname;

export interface Measured {
  ordinary: { total: number; held: { source: string; text: string; findings: Finding[] }[]; bySource: Record<string, { total: number; held: number }> };
  planted: { total: number; missed: string[] };
  gitleaks: { rules: number; tps: number; caught: number; missed: { rule: string; text: string }[]; fps: number; fpsHeld: number };
  ms: number;
}

// The secrets context the corpus runs under: planted env, .env and never-share file.
export function plantedSecrets(): { secrets: Secrets; cleanup: () => void } {
  const { repo, neverShare: ns } = plantFiles();
  const n = neverShare(ns);
  const secrets: Secrets = {
    exact: [...envValues(ENV), ...dotenvFiles(repo).flatMap((f) => dotenvValues(f)), ...n.exact],
    shingles: n.shingles ? [n.shingles] : [],
  };
  return { secrets, cleanup: () => rmSync(dirname(repo), { recursive: true, force: true }) };
}

export function measure(): Measured {
  const start = Date.now();
  const { secrets, cleanup } = plantedSecrets();
  try {
    const held = (text: string): Finding[] => scan(fieldsOf({ text }), secrets);

    const corpus = JSON.parse(readFileSync(join(HERE, "ordinary.json"), "utf8")) as { messages: { source: string; text: string }[] };
    const bySource: Record<string, { total: number; held: number }> = {};
    const ordinaryHeld: Measured["ordinary"]["held"] = [];
    for (const m of corpus.messages) {
      const s = (bySource[m.source] ??= { total: 0, held: 0 });
      s.total++;
      const f = held(m.text);
      if (f.length) {
        s.held++;
        ordinaryHeld.push({ ...m, findings: f });
      }
    }

    const cases = catchCases();
    const missed = cases.filter((c) => held(c.text).length === 0).map((c) => c.name);

    const fx = JSON.parse(readFileSync(join(HERE, "gitleaks-fixtures.json"), "utf8")) as { fixtures: { rule: string; tps: string[]; fps: string[] }[] };
    let tps = 0;
    let caught = 0;
    let fps = 0;
    let fpsHeld = 0;
    const glMissed: { rule: string; text: string }[] = [];
    // Patterns only: gitleaks' fixtures know nothing of this machine's values.
    const none: Secrets = { exact: [], shingles: [] };
    for (const f of fx.fixtures) {
      for (const t of f.tps) {
        tps++;
        if (scan(fieldsOf({ text: t }), none).length) caught++;
        else glMissed.push({ rule: f.rule, text: t });
      }
      for (const t of f.fps) {
        fps++;
        if (scan(fieldsOf({ text: t }), none).length) fpsHeld++;
      }
    }
    return {
      ordinary: { total: corpus.messages.length, held: ordinaryHeld, bySource },
      planted: { total: cases.length, missed },
      gitleaks: { rules: fx.fixtures.filter((f) => f.tps.length).length, tps, caught, missed: glMissed, fps, fpsHeld },
      ms: Date.now() - start,
    };
  } finally {
    cleanup();
  }
}
