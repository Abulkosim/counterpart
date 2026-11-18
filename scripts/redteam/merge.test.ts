// node --test scripts/redteam/*.test.ts (smoke.sh runs it)
import assert from "node:assert/strict";
import { test } from "node:test";
import { failedLabel, merge, mismatch, type Saved } from "./merge.ts";

interface Row {
  attack: string;
  trial: number;
  commit: string;
}
const prev: Saved<Row> = {
  guard: "off",
  victim: "claude",
  brief: "help",
  model: "m1",
  at: "t0",
  commit: "old",
  results: [
    { attack: "A06", trial: 1, commit: "old" },
    { attack: "A06", trial: 2, commit: "old" },
    { attack: "C01", trial: 1, commit: "old" },
    { attack: "C01", trial: 2, commit: "old" },
  ],
};
const run = { at: "t1", commit: "new", attacks: ["C01"] };

test("a rerun replaces the rows of its attacks", () => {
  const m = merge(prev, [{ attack: "C01", trial: 1, commit: "new" }], new Set(["C01"]), new Set(), run);
  assert.deepEqual(m.results.map((r) => `${r.attack}/${r.trial}/${r.commit}`), ["A06/1/old", "A06/2/old", "C01/1/new"]);
  assert.deepEqual(m.runs, [{ at: "t0", commit: "old", attacks: "all" }, run]);
});

test("a trial that failed to run keeps its earlier row", () => {
  const failed = new Set([failedLabel("C01", 1)]);
  const m = merge(prev, [{ attack: "C01", trial: 2, commit: "new" }], new Set(["C01"]), failed, { ...run, failed: [...failed] });
  assert.deepEqual(m.results.map((r) => `${r.attack}/${r.trial}/${r.commit}`), ["A06/1/old", "A06/2/old", "C01/1/old", "C01/2/new"]);
  assert.deepEqual(m.runs.at(-1)?.failed, ["C01 trial 1"]);
});

test("every trial failed: nothing is lost", () => {
  const failed = new Set([failedLabel("C01", 1), failedLabel("C01", 2)]);
  const m = merge(prev, [], new Set(["C01"]), failed, run);
  assert.deepEqual(m.results, prev.results);
});

test("results of another kind or model do not mix", () => {
  const now = { guard: "off", victim: "claude", brief: "help", model: "m1" };
  assert.equal(mismatch(prev, now), null);
  assert.match(mismatch(prev, { ...now, model: "m2" }) ?? "", /model m1, not m2/);
  assert.match(mismatch(prev, { ...now, guard: "on" }) ?? "", /guard off, not on/);
  assert.match(mismatch(prev, { ...now, victim: "fake-clean" }) ?? "", /victim/);
  // Files from before the brief was recorded are the help brief.
  assert.equal(mismatch({ guard: "off", victim: "claude", model: "m1" }, now), null);
  // Files from before the model was compared do not silently take a new model.
  assert.match(mismatch({ guard: "off", victim: "claude", brief: "help" }, now) ?? "", /model/);
});
