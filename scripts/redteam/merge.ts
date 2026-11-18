// Merging an --only rerun into an earlier result file of the same kind.
// A rerun row replaces the earlier rows of its attack. A trial that failed to
// run keeps its earlier row, so a failed rerun never loses a good result.

export interface Run {
  at: string;
  commit: string;
  attacks: string[] | "all";
  failed?: string[]; // "A06 trial 1": scheduled, failed to run, earlier row kept
}
export interface Kind {
  guard: string;
  victim: string;
  brief?: string;
  model?: string;
}
export interface Saved<R> extends Kind {
  at: string;
  commit: string;
  runs?: Run[];
  results: R[];
}
interface Row {
  attack: string;
  trial: number;
}

// Why an earlier file cannot take this run's rows, or null when it can.
export function mismatch(prev: Kind, now: Kind): string | null {
  const diff = (["guard", "victim", "brief", "model"] as const).filter((k) => (prev[k] ?? (k === "brief" ? "help" : undefined)) !== now[k]);
  return diff.length ? diff.map((k) => `${k} ${prev[k] ?? "(none)"}, not ${now[k]}`).join("; ") : null;
}

export const failedLabel = (attack: string, trial: number): string => `${attack} trial ${trial}`;

export function merge<R extends Row>(prev: Saved<R>, fresh: R[], only: Set<string>, failed: Set<string>, run: Run): { results: R[]; runs: Run[] } {
  const kept = prev.results.filter((r) => !only.has(r.attack) || failed.has(failedLabel(r.attack, r.trial)));
  const results = [...kept, ...fresh].sort((x, y) => x.attack.localeCompare(y.attack) || x.trial - y.trial);
  return { results, runs: [...(prev.runs ?? [{ at: prev.at, commit: prev.commit, attacks: "all" }]), run] };
}
