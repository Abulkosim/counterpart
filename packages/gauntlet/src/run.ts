import { Ctx } from "./harness.ts";
import type { Case } from "./types.ts";

// held: the defence worked. failed: it did not, and nobody knew.
// open: it did not, and the case is marked as a known failure.
// fixed: the case is marked as a known failure but the defence now works.
export type Status = "held" | "failed" | "open" | "fixed";

export interface Outcome {
  case: Case;
  status: Status;
  ms: number;
  error?: Error;
}

export async function runCase(c: Case, timeoutMs = 30_000): Promise<Outcome> {
  const ctx = new Ctx();
  const started = performance.now();
  let error: Error | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      c.run(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${c.id} did not finish in ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
    await ctx.close();
  }
  const status: Status = error ? (c.knownFailure ? "open" : "failed") : c.knownFailure ? "fixed" : "held";
  return { case: c, status, ms: Math.round(performance.now() - started), ...(error ? { error } : {}) };
}

export async function runAll(list: Case[], onResult: (o: Outcome) => void = () => {}): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const c of list) {
    const o = await runCase(c);
    onResult(o);
    out.push(o);
  }
  return out;
}
