import { test } from "node:test";
import assert from "node:assert/strict";
import { cases, problems, runCase } from "../src/index.ts";

test("the catalogue is well formed", () => {
  assert.deepEqual(problems(), []);
});

const fixed: string[] = [];

for (const c of cases) {
  test(`${c.id} ${c.title}`, c.knownFailure ? { todo: c.knownFailure } : {}, async () => {
    const o = await runCase(c);
    if (o.status === "fixed") fixed.push(c.id);
    if (!o.error) return;
    if (!c.knownFailure) throw o.error;
    // Expected, so one line is enough. The full error is in `pnpm gauntlet <id>`.
    const brief = new Error(o.error.message.split("\n")[0]);
    brief.stack = brief.message;
    throw brief;
  });
}

// A known failure that starts passing means the defect was fixed. The marker
// has to go, or the report keeps listing a finding that is no longer true.
test("every known failure still fails", () => {
  assert.deepEqual(fixed, [], "these cases pass now: remove their knownFailure and finding");
});
