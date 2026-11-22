// How often the piece check holds an ordinary message by chance. Checks the
// ordinary corpus against many random keys of common shapes (a fixed prefix
// and a random part), so any hold is a coincidence. Also checks that a piece
// of each key with the documented number of random characters is held, and
// that the fixed prefix with a few random characters is not. See docs/guard.md.
//
//   node scripts/guard-stress.ts [keys]
//
// Needs node 24 only. No model, no network. 9 s with the default 300 keys on a
// shared 2-core machine.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envValues, fieldsOf, scan } from "../packages/daemon/src/guard.ts";

const N = Number(process.argv[2] ?? 300);
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOW = "abcdefghijklmnopqrstuvwxyz0123456789";
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const rand = (n: number, a: string): string => [...randomBytes(n)].map((b) => a[b % a.length]).join("");
const SHAPES: [string, () => string][] = [
  ["sk_live_", () => rand(32, B62)],
  ["sr_live_", () => rand(32, B62)],
  ["ghp_", () => rand(36, B62)],
  ["pt_", () => rand(32, LOW)],
  ["svc_", () => rand(32, LOW)],
  ["AKIA", () => rand(16, UP)],
  ["", () => rand(40, B62)],
  ["", () => randomBytes(16).toString("hex")],
];

const env: Record<string, string> = {};
const keys: { prefix: string; random: string }[] = [];
for (let i = 0; i < N; i++) {
  const [prefix, make] = SHAPES[i % SHAPES.length]!;
  const random = make();
  keys.push({ prefix, random });
  env[`STRESS_${i}_TOKEN`] = prefix + random;
}
const secrets = { exact: envValues(env), shingles: [] };
const corpus = JSON.parse(readFileSync(join(import.meta.dirname, "../packages/daemon/test/guard-corpus/ordinary.json"), "utf8")) as { messages: { text: string }[] };
const t = Date.now();
let held = 0;
for (const m of corpus.messages) if (scan(fieldsOf({ text: m.text }), secrets).length) held++;
console.log(`${corpus.messages.length} ordinary messages against ${N} random keys: ${held} held (${Date.now() - t} ms)`);

const count = (pick: (k: { prefix: string; random: string }) => string): number => keys.filter((k) => scan(fieldsOf({ text: `the key is ${pick(k)} if that helps` }), secrets).length > 0).length;
for (const n of [4, 6, 7, 8, 10]) console.log(`prefix and the first ${n} random characters: ${count((k) => k.prefix + k.random.slice(0, n))} of ${N} held`);
console.log(`prefix, 4 random characters and the last 4: ${count((k) => `starts with ${k.prefix}${k.random.slice(0, 4)}, ends in ...${k.random.slice(-4)}`)} of ${N} held`);
console.log(`8 random characters from the middle: ${count((k) => k.random.slice(5, 13))} of ${N} held`);
