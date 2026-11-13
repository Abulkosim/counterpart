import { test } from "node:test";
import assert from "node:assert/strict";
import { type Contract, type Evidence, EVIDENCE_LIMITS, canonicalize, checkEvidenceParts, isHttpsUrl, parseCanonical, parseEvidence, parseEvent, partDigest, utf8 } from "../src/index.ts";

const SCHEMA = '{"type":"object"}';
const good: Evidence = {
  v: 1, proposalId: "p".repeat(22), contractHash: "c".repeat(43), repo: "alice/orders-api", pr: "https://github.com/alice/orders-api/pull/7",
  head: "a".repeat(40), base: "b".repeat(64), bindingsHash: "1".repeat(64), trustPolicyHash: "2".repeat(64),
  verifier: { version: "1", sha256: "3".repeat(64) },
  parts: [{ part: "page.schema.json", path: "schemas/page.schema.json", sha256: partDigest(SCHEMA), ok: true }, { part: "terms.txt", path: "docs/terms.txt", ok: false }],
  run: { url: "https://github.com/alice/orders-api/actions/runs/1", status: "failure" },
};
const contract: Contract = { v: 1, title: "t", text: "x", parties: ["a".repeat(43), "b".repeat(43)], parts: [{ kind: "json-schema", name: "page.schema.json", content: SCHEMA }, { kind: "text", name: "terms.txt", content: "terms" }, { kind: "text", name: "extra.md", content: "extra" }] };

test("evidence round-trips through canonical JSON and the optional fields are optional", () => {
  assert.deepEqual(parseEvidence(parseCanonical(utf8(canonicalize(good)))), good);
  const { pr: _pr, run: _run, ...bare } = good;
  assert.deepEqual(parseEvidence(bare), bare);
  const event = { id: "e".repeat(22), threadId: "t".repeat(22), author: `d_${"x".repeat(22)}`, authorSeq: 3, parents: [], lane: "act", type: "evidence.posted", body: good, createdAt: 1 };
  assert.equal(parseEvent(event).type, "evidence.posted");
  assert.throws(() => parseEvent({ ...event, lane: "talk" }), /wrong lane/);
  assert.throws(() => parseEvent({ ...event, body: { ...good, extra: 1 } }), /bad evidence.posted body/);
});

test("evidence with a wrong shape, an unknown field or an oversized field is refused", () => {
  const part = good.parts[0]!;
  const bad: unknown[] = [
    null, [], "x", { ...good, v: 2 }, { ...good, extra: true }, { ...good, proposalId: "short" }, { ...good, contractHash: "x" },
    { ...good, repo: "" }, { ...good, repo: "a".repeat(EVIDENCE_LIMITS.repo + 1) }, { ...good, repo: "alice api" }, { ...good, repo: "-rf" }, { ...good, repo: "a\u202eb" },
    { ...good, head: "HEAD" }, { ...good, head: "A".repeat(40) }, { ...good, base: "a".repeat(41) },
    { ...good, bindingsHash: "1".repeat(63) }, { ...good, trustPolicyHash: 7 },
    { ...good, verifier: { version: "1" } }, { ...good, verifier: { version: "", sha256: "3".repeat(64) } }, { ...good, verifier: { version: "1", sha256: "3".repeat(64), name: "x" } },
    { ...good, parts: [] }, { ...good, parts: "x" }, { ...good, parts: Array.from({ length: EVIDENCE_LIMITS.parts + 1 }, (_, i) => ({ ...part, path: `p/${i}` })) },
    { ...good, parts: [part, part] }, { ...good, parts: [{ ...part, path: "a/../b" }] }, { ...good, parts: [{ ...part, path: "/abs" }] }, { ...good, parts: [{ ...part, path: "a//b" }] },
    { ...good, parts: [{ ...part, path: "C:\\x" }] }, { ...good, parts: [{ ...part, path: "caf\u00e9.json" }] }, { ...good, parts: [{ ...part, path: "a".repeat(EVIDENCE_LIMITS.path + 1) }] },
    { ...good, parts: [{ ...part, part: "a/b" }] }, { ...good, parts: [{ ...part, sha256: "zz" }] }, { ...good, parts: [{ ...part, ok: 1 }] }, { ...good, parts: [{ part: part.part, path: part.path, ok: true }] },
    { ...good, pr: "http://github.com/x" }, { ...good, pr: null }, { ...good, run: { url: good.run!.url } }, { ...good, run: { url: good.run!.url, status: "passed" } }, { ...good, run: { url: "javascript:alert(1)", status: "success" } },
  ];
  for (const b of bad) assert.throws(() => parseEvidence(b), /^Error: evidence: /, JSON.stringify(b)?.slice(0, 120));
});

test("a URL is accepted only as short plain https without credentials", () => {
  for (const ok of ["https://github.com/a/b/pull/1", "https://ci.example.com:8443/run?id=1&x=%20#top"]) assert.equal(isHttpsUrl(ok), true, ok);
  for (const bad of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "http://a.example/", "ftp://a.example/", "file:///etc/passwd", "//a.example/", "a.example/x", "https:a.example",
    "https://", "https:///x", "https://u:p@a.example/", "https://u@a.example/", "https://a.example/ x", "https://a.example/\tx", "https://a.example/\nx", "https://a.example/\u0000", "https://a.example/\u001b[0m",
    "https://a.example/\u202e", "https://a.example/\u00e9", "https://\u0430.example/", "https://a.example/<script>", "https://a.example/\"x", "https://a.example/'x", "https://a.example/`x", "https://a.example/\\x", "https://a.example/{x}",
    " https://a.example/", `https://a.example/${"a".repeat(EVIDENCE_LIMITS.url)}`, "", 1, null, undefined, ["https://a.example/"],
  ])
    assert.equal(isHttpsUrl(bad), false, JSON.stringify(bad));
});

test("part digests are compared with the signed contract, whatever the sender claims", () => {
  const lying: Evidence = { ...good, parts: [{ ...good.parts[0]!, sha256: "f".repeat(64), ok: true }, { part: "terms.txt", path: "docs/terms.txt", sha256: partDigest("terms"), ok: false }, { part: "ghost.md", path: "ghost.md", sha256: partDigest("x"), ok: true }] };
  const r = checkEvidenceParts(lying, contract);
  assert.deepEqual(r.parts.map((p) => [p.part, p.check, p.claimedOk]), [["page.schema.json", "mismatch", true], ["terms.txt", "match", false], ["ghost.md", "unknown-part", true]]);
  assert.equal(r.parts[0]!.signedSha256, partDigest(SCHEMA));
  assert.equal(r.parts[2]!.signedSha256, null);
  assert.deepEqual(r.unreported, ["extra.md"]);
  assert.deepEqual(checkEvidenceParts(good, contract).parts.map((p) => p.check), ["match", "missing"]);
  // The digest is over the UTF-8 bytes, the same bytes the verifier compares with the file.
  assert.equal(partDigest("caf\u00e9"), "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e");
});
