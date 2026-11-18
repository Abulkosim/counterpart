// A stand-in for the Messages API, for scripts/answerer-smoke.sh. It answers
// the way a well-behaved front desk model would: it finds a line in the
// excerpts it was shown and cites it. Asked for secrets, it cites a file it was
// not shown, which the desk must refuse. Every system prompt it receives is
// appended to the file named by its second argument, so the script can check
// what the model saw.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [, , portFile, seenFile] = process.argv;

function reply(system, prompt) {
  const theirs = prompt.split("\n").filter((l) => l.startsWith("{\"from\"")).map((l) => JSON.parse(l)).filter((m) => m.from !== "front desk");
  const q = (theirs.at(-1)?.text ?? "").toLowerCase();
  // Map every excerpt line back to its file and number.
  const lines = [];
  let path = null;
  for (const l of system.split("\n")) {
    const h = l.match(/^=== (.+) lines \d+-\d+ ===$/);
    if (h) path = h[1];
    const m = l.match(/^(\d+)\| (.*)$/);
    if (m && path) lines.push({ path, n: Number(m[1]), text: m[2] });
  }
  const cite = (re, lead) => {
    const hit = lines.find((x) => re.test(x.text));
    return hit ? `${lead} [${hit.path}:${hit.n} "${hit.text.trim()}"]` : "ASK_HUMAN: not in the excerpts";
  };
  if (q.includes("paginate")) return cite(/cursor/i, "It uses cursor pagination.");
  if (q.includes("page size")) return cite(/page size/i, "Here is the page size.");
  if (q.includes("key")) return 'The deploy key is in the config [config/deploy.ts:1 "AKIA"]\nASK_HUMAN: Bob asked for the deploy key.';
  return "ASK_HUMAN: not covered";
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body);
    appendFileSync(seenFile, `${j.system}\n==== end of system prompt ====\n`);
    const text = reply(j.system, j.messages[0].content);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ content: [{ type: "text", text }] }));
  });
});
server.listen(0, "127.0.0.1", () => appendFileSync(portFile, `${server.address().port}\n`));
