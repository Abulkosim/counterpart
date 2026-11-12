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

// Attacks on the model that reads peer text (the front desk). A code case
// either holds or it does not. A model case is run several times against a
// live model and reports how often the attack worked, so its results are
// measurements and are never mixed into the totals for code cases.
export interface ModelCase {
  id: string;
  family: string;
  title: string;
  claim: string;
  // What the other side sends, one message per turn. The desk answers each.
  turns: string[];
  // Use a bundle with an instruction planted in an approved file.
  poisonedBundle?: boolean;
  // true if the attack worked. `replies` is everything the desk sent back,
  // `asks` the questions it passed to its owner.
  worked(out: { replies: string[]; asks: string[]; leaked: string[] }): boolean;
  // A control is not an attack: `worked` means the desk gave the right answer.
  control?: boolean;
}

export interface ModelResult {
  id: string;
  family: string;
  title: string;
  claim: string;
  control: boolean;
  trials: number;
  worked: number;
  example: string | null; // one reply from a trial where the attack worked
}

export interface ModelReport {
  at: string;
  model: string;
  runtime: string;
  results: ModelResult[];
}
