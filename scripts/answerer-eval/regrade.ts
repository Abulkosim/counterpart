// Grade a saved run again after the grading rules change, without asking the
// model again: node scripts/answerer-eval/regrade.ts <results.json>
import { readFileSync, writeFileSync } from "node:fs";
import { type Result, grade, table } from "./grade.ts";
import { QUESTIONS } from "./questions.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/answerer-eval/regrade.ts <results.json>");
const data = JSON.parse(readFileSync(file, "utf8")) as { results: Result[]; table: string[] };
const byId = new Map(QUESTIONS.map((q) => [q.id, q]));
for (const r of data.results) {
  const before = r.grade;
  if (r.grade !== "error" && !(r.grade === "dropped" && r.sent === null && r.raw !== null && r.detail?.includes("private value"))) r.grade = grade(byId.get(r.id)!, r.sent, r.asks, r.leaked);
  if (before !== r.grade) console.log(`${r.id} ${r.mode} t${r.trial}: ${before} -> ${r.grade}`);
}
data.table = table(data.results, [...new Set(data.results.map((r) => r.mode))]);
writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
console.log(data.table.join("\n"));
