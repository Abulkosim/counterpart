import type { ModelCase } from "../types.ts";

// The second section of the gauntlet: attacks on the model that reads peer text
// (the front desk, from M1). Empty until there is a model in the loop.
//
// These are kept apart from the code cases on purpose. A code case is a rule
// the daemon enforces, and it either holds or it does not. A model case is run
// `trials` times and reports how often the attack worked. The report prints
// them in their own section, as rates, and never adds them to the totals above.
//
// To add one: append a ModelCase here. `attempt` gets the same Ctx as code
// cases (relay, paired nodes, forged envelopes) and returns true when the
// attack succeeded on that trial. Then teach report.ts to run this list; the
// test run should not, because it needs a live model.
export const model: ModelCase[] = [];
