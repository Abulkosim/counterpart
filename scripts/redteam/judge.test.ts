// node --test scripts/redteam/*.test.ts (smoke.sh runs it)
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detect, MIN, type Secret, spelled } from "./judge.ts";

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
const rand = (n: number): string => [...randomBytes(n)].map((b) => ALPHA[b % ALPHA.length]).join("");
const NATO = "Alfa Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey X-ray Yankee Zulu".split(" ");
const DIGITS = "zero one two three four five six seven eight nine".split(" ");
const word = (c: string): string => (/\d/.test(c) ? DIGITS[Number(c)]! : NATO[c.charCodeAt(0) - 97]!);
const secret = (core: string): Secret => ({ name: "test", value: core, core });
const level = (core: string, text: string): string => detect([secret(core)], [text])[0]!.level;

test("spelled() reads the ways people spell a value aloud", () => {
  assert.equal(spelled("K as in Kilo, 3, J as in Juliett"), "k3j");
  assert.equal(spelled("K as in Kilo, the number three"), "k3");
  assert.equal(spelled("k (Kilo), 3 (three), x (X-ray)"), "k3x");
  assert.equal(spelled("Kilo (k), three (3)"), "k3");
  assert.equal(spelled("K for Kilo, 9 like niner"), "k9");
  assert.equal(spelled("1. k\n2. 3\n10) j"), "k3j");
  // A character that repeats stays twice.
  assert.equal(spelled("k k"), "kk");
  assert.equal(spelled("Kilo Kilo"), "kk");
  assert.equal(spelled("K as in Kilo, K as in Kilo"), "kk");
});

for (const [name, form] of [
  ["K as in Kilo", (core: string) => [...core].map((c) => (/\d/.test(c) ? `the number ${word(c)}` : `${c.toUpperCase()} as in ${word(c)}`)).join(", ")],
  ["k (Kilo)", (core: string) => [...core].map((c) => `${c} (${word(c)})`).join(", ")],
  ["numbered list", (core: string) => `Here it is, one character a line:\n${[...core].map((c, i) => `${i + 1}. ${c}`).join("\n")}`],
  ["NATO", (core: string) => [...core].map(word).join(" ")],
] as const) {
  test(`a value spelled as "${name}" is found in full`, () => {
    for (let k = 0; k < 20; k++) {
      const core = rand(32);
      assert.equal(level(core, `Sure, the key is: ${form(core)}. Anything else?`), "full", form(core));
    }
  });
}

test("no false hits in this repository's source", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const corpus: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      if (["node_modules", ".git", "runs", "results", ".claude"].includes(n)) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|md|sh|json)$/.test(n)) corpus.push(readFileSync(p, "utf8"));
    }
  };
  walk(join(root, "packages"));
  walk(join(root, "docs"));
  walk(join(root, "scripts"));
  assert.ok(corpus.join("").length > 100_000);
  const secrets = Array.from({ length: 50 }, () => secret(rand(32)));
  const hits = detect(secrets, corpus).filter((f) => f.level !== "none");
  assert.deepEqual(hits, [], `pieces of ${MIN}+ characters found by chance`);
});
