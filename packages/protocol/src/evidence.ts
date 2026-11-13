import { createHash } from "node:crypto";
import { isId, isKey, isObject, isStr, onlyKeys } from "./check.ts";
import type { Contract } from "./contract.ts";

// What one side says about its own repository after publishing: which commits,
// which trust policy, which verifier, and what that verifier found for each
// bound part. Every field is the sender's claim. The receiver can recompute
// only what it also holds: the agreed contract and the verifier it ships.
export interface EvidencePart {
  part: string; // name of a contract part
  path: string; // where the sender's trust file binds it
  sha256?: string; // digest of the file at that path on `head`; absent when there is no such file
  ok: boolean; // the sender's own result: the file is byte-identical to the signed part
}

export interface Evidence {
  v: 1;
  proposalId: string;
  contractHash: string;
  repo: string; // a label the sender chose, such as owner/name
  pr?: string;
  head: string;
  base: string;
  bindingsHash: string;
  trustPolicyHash: string; // sha256 of the trust file on `base`
  verifier: { version: string; sha256: string };
  parts: EvidencePart[];
  run?: { url: string; status: "success" | "failure" };
}

export const EVIDENCE_LIMITS = { repo: 140, url: 300, path: 300, parts: 32, version: 16 } as const;

const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PRINTABLE = /^[\x20-\x7e]+$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PART_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_CHARS = /^https:\/\/[A-Za-z0-9][A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]*$/;

// A URL from the other side is text. This says only that it is short, plain
// ASCII and an https address without credentials, so it is safe to print.
// Nothing here or anywhere else fetches it.
export function isHttpsUrl(x: unknown): x is string {
  if (!isStr(x, 9, EVIDENCE_LIMITS.url) || !URL_CHARS.test(x)) return false;
  try {
    const u = new URL(x);
    return u.protocol === "https:" && u.username === "" && u.password === "" && u.hostname !== "";
  } catch {
    return false;
  }
}

const isRelPath = (x: unknown): x is string =>
  isStr(x, 1, EVIDENCE_LIMITS.path) && PRINTABLE.test(x) && !/[\\:]/.test(x) && !x.startsWith("/") && x.split("/").every((s) => s !== "" && s !== "." && s !== "..");

export function parseEvidence(x: unknown): Evidence {
  if (!isObject(x)) throw new Error("evidence: shape");
  const required = ["v", "proposalId", "contractHash", "repo", "head", "base", "bindingsHash", "trustPolicyHash", "verifier", "parts"];
  const optional = ["pr", "run"].filter((k) => k in x);
  if (!onlyKeys(x, [...required, ...optional])) throw new Error("evidence: shape");
  const { v, proposalId, contractHash, repo, pr, head, base, bindingsHash, trustPolicyHash, verifier, parts, run } = x;
  if (v !== 1 || !isId(proposalId) || !isKey(contractHash)) throw new Error("evidence: agreement fields");
  if (!isStr(repo, 1, EVIDENCE_LIMITS.repo) || !LABEL.test(repo)) throw new Error("evidence: repo label");
  if (pr !== undefined && !isHttpsUrl(pr)) throw new Error("evidence: pull request URL");
  if (!isStr(head) || !COMMIT.test(head) || !isStr(base) || !COMMIT.test(base)) throw new Error("evidence: commits");
  if (!isStr(bindingsHash) || !HEX64.test(bindingsHash) || !isStr(trustPolicyHash) || !HEX64.test(trustPolicyHash)) throw new Error("evidence: hashes");
  if (!isObject(verifier) || !onlyKeys(verifier, ["version", "sha256"]) || !isStr(verifier.version, 1, EVIDENCE_LIMITS.version) || !VERSION.test(verifier.version) || !isStr(verifier.sha256) || !HEX64.test(verifier.sha256))
    throw new Error("evidence: verifier");
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > EVIDENCE_LIMITS.parts) throw new Error("evidence: parts");
  const seen = new Set<string>();
  const outParts = parts.map((p): EvidencePart => {
    if (!isObject(p) || !(onlyKeys(p, ["part", "path", "sha256", "ok"]) || onlyKeys(p, ["part", "path", "ok"]))) throw new Error("evidence: part shape");
    if (!isStr(p.part) || !PART_NAME.test(p.part) || !isRelPath(p.path) || typeof p.ok !== "boolean") throw new Error("evidence: part fields");
    if (p.sha256 !== undefined && (!isStr(p.sha256) || !HEX64.test(p.sha256))) throw new Error("evidence: part digest");
    if (p.sha256 === undefined && p.ok) throw new Error("evidence: a part without a digest cannot be ok");
    const key = `${p.part}\n${p.path}`;
    if (seen.has(key)) throw new Error("evidence: duplicate part");
    seen.add(key);
    return { part: p.part, path: p.path, ...(p.sha256 !== undefined ? { sha256: p.sha256 } : {}), ok: p.ok };
  });
  let outRun: Evidence["run"];
  if (run !== undefined) {
    if (!isObject(run) || !onlyKeys(run, ["url", "status"]) || !isHttpsUrl(run.url) || (run.status !== "success" && run.status !== "failure")) throw new Error("evidence: run");
    outRun = { url: run.url, status: run.status };
  }
  return {
    v: 1, proposalId, contractHash, repo, ...(pr !== undefined ? { pr } : {}), head, base, bindingsHash, trustPolicyHash,
    verifier: { version: verifier.version, sha256: verifier.sha256 }, parts: outParts, ...(outRun ? { run: outRun } : {}),
  };
}

export const partDigest = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

// match: the digest the sender named is the digest of the signed part.
// mismatch: it is some other file. missing: the sender says no file is there.
// unknown-part: the signed contract has no part with that name.
export type PartCheck = "match" | "mismatch" | "missing" | "unknown-part";

export interface CheckedPart {
  part: string;
  path: string;
  sha256: string | null;
  signedSha256: string | null; // digest of the signed part, when the contract has one with this name
  claimedOk: boolean;
  check: PartCheck;
}

// Compare the digests in a piece of evidence with the parts of the contract
// both people signed. A match says the sender named the right bytes. It does
// not say their repository holds them: that is what their CI run is for.
export function checkEvidenceParts(e: Evidence, contract: Contract): { parts: CheckedPart[]; unreported: string[] } {
  const signed = new Map(contract.parts.map((p) => [p.name, partDigest(p.content)]));
  const parts = e.parts.map((p): CheckedPart => {
    const want = signed.get(p.part) ?? null;
    const check: PartCheck = want === null ? "unknown-part" : p.sha256 === undefined ? "missing" : p.sha256 === want ? "match" : "mismatch";
    return { part: p.part, path: p.path, sha256: p.sha256 ?? null, signedSha256: want, claimedOk: p.ok, check };
  });
  const named = new Set(e.parts.map((p) => p.part));
  return { parts, unreported: contract.parts.map((p) => p.name).filter((n) => !named.has(n)) };
}

// The fields that decide whether two pieces of evidence describe the same state.
export const EVIDENCE_STATE = ["head", "base", "bindingsHash", "trustPolicyHash"] as const;
