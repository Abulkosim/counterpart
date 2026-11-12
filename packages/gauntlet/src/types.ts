import type { Ctx } from "./harness.ts";

export type Attacker = "stranger" | "contact" | "relay" | "network";

export const CATEGORIES = {
  envelope: "Envelope and identity",
  parsing: "Canonical form and parsing",
  replay: "Replay and ordering",
  authority: "Authority",
  "hostile-relay": "The relay as attacker",
  "relay-clients": "Clients attacking the relay",
  output: "Terminal output",
  storage: "Local storage",
} as const;

export type Category = keyof typeof CATEGORIES;

export interface Finding {
  severity: "high" | "medium" | "low";
  where: string; // file:line of the code at fault
  scenario: string;
  fix: string;
}

export interface Case {
  id: string;
  category: Category;
  title: string;
  attacker: Attacker;
  claim: string; // the rule being tested, one sentence
  run(ctx: Ctx): Promise<void>; // throws if the defence fails
  // Set when the case exposes a defect that is not fixed yet. The test run
  // reports it as todo and the report lists it under "Open findings".
  knownFailure?: string;
  finding?: Finding;
}

// Attacks on the model that reads peer text. A code case either holds or it
// does not. A model case is run many times and reports how often the attack
// worked, so its results are measurements and are never mixed into the totals
// for code cases.
export interface ModelCase {
  id: string;
  title: string;
  attacker: Attacker;
  claim: string;
  trials: number;
  attempt(ctx: Ctx): Promise<boolean>; // true if the attack succeeded on this trial
}
