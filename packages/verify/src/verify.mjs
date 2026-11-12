#!/usr/bin/env node
// Counterpart repo verifier. One file, no dependencies beyond Node itself, so
// a repo owner can read all of it before letting it run in their CI.
//
// It answers one question about a checkout: does this tree carry what two
// people signed? It reads files as data. It never imports, requires or runs
// anything from the tree it is checking.
//
//   node verify.mjs --tree <checkout to check> --trust <trust.json from the protected base branch>
//
// The trust file comes from the base branch, never from the change under
// review, so a pull request cannot name its own signers or point a binding at
// a decorative file.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const VERIFIER_VERSION = "1";
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 500;

// ---- canonical JSON and signatures: must match packages/protocol exactly ----

export function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("only safe integers allowed");
    return String(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error("malformed string");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${canonicalize(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  throw new Error("unsupported value");
}

const sha256 = (data) => createHash("sha256").update(data).digest();
const hashOf = (value) => sha256(canonicalize(value)).toString("base64url");
const hex = (data) => sha256(data).toString("hex");
const isKey = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x) && Buffer.from(x, "base64url").toString("base64url") === x;
const isId = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(x);
const isObject = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const sameKeys = (x, keys) => Object.keys(x).length === keys.length && keys.every((k) => k in x);

function verifySignature(publicKey, domain, message, signature) {
  try {
    const sig = Buffer.from(signature, "base64url");
    if (sig.length !== 64 || sig.toString("base64url") !== signature) return false;
    const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: publicKey } });
    return edVerify(null, Buffer.concat([Buffer.from(`counterpart/${domain}\n`), Buffer.from(message)]), key, sig);
  } catch {
    return false;
  }
}

function sortedPair(x) {
  return Array.isArray(x) && x.length === 2 && x.every(isKey) && x[0] < x[1];
}

// Checks an agreement file the same way `cpart agreement verify` does.
export function verifyAgreement(a) {
  if (!isObject(a) || !sameKeys(a, ["v", "contract", "contractHash", "proposalId", "genesis", "approvals"])) throw new Error("agreement: shape");
  if (a.v !== 1 || !isKey(a.contractHash) || !isId(a.proposalId)) throw new Error("agreement: fields");
  const c = a.contract;
  if (!isObject(c) || !sameKeys(c, ["v", "title", "text", "parties", "parts"]) || c.v !== 1) throw new Error("agreement: contract shape");
  if (typeof c.title !== "string" || typeof c.text !== "string" || !sortedPair(c.parties) || !Array.isArray(c.parts)) throw new Error("agreement: contract fields");
  for (const p of c.parts) {
    if (!isObject(p) || !sameKeys(p, ["kind", "name", "content"]) || typeof p.name !== "string" || typeof p.content !== "string") throw new Error("agreement: part shape");
  }
  if (new Set(c.parts.map((p) => p.name)).size !== c.parts.length) throw new Error("agreement: duplicate part name");
  if (hashOf(c) !== a.contractHash) throw new Error("agreement: the contract does not match its hash");

  const g = a.genesis;
  if (!isObject(g) || g.type !== "thread.opened" || !isObject(g.body) || !Array.isArray(g.body.participants)) throw new Error("agreement: genesis is not a thread opening");
  if ([...g.body.participants].sort().join() !== c.parties.join()) throw new Error("agreement: the thread is between different people than the contract");
  const genesisHash = hashOf(g);

  if (!Array.isArray(a.approvals) || a.approvals.length !== 2) throw new Error("agreement: needs exactly two approvals");
  for (const ap of a.approvals) {
    if (!isObject(ap) || !sameKeys(ap, ["v", "threadGenesis", "proposalId", "contractHash", "parties", "approver", "approvedAt", "sig"])) throw new Error("approval: shape");
    if (ap.v !== 1 || !isKey(ap.approver) || typeof ap.sig !== "string" || !Number.isSafeInteger(ap.approvedAt) || !sortedPair(ap.parties)) throw new Error("approval: fields");
    const { sig, ...body } = ap;
    if (!verifySignature(ap.approver, "approval/v1", canonicalize(body), sig)) throw new Error("approval: bad signature");
    if (ap.contractHash !== a.contractHash) throw new Error("agreement: an approval is for a different contract");
    if (ap.proposalId !== a.proposalId) throw new Error("agreement: an approval is for a different proposal");
    if (ap.threadGenesis !== genesisHash) throw new Error("agreement: an approval is from a different thread");
    if (ap.parties.join() !== c.parties.join()) throw new Error("agreement: an approval names different parties");
  }
  if (a.approvals.map((x) => x.approver).sort().join() !== c.parties.join()) throw new Error("agreement: the two approvals must come from the two parties");
  return { contract: c, contractHash: a.contractHash, proposalId: a.proposalId, genesisHash };
}

// ---- a small JSON Schema checker ----
//
// Supports the keywords below and refuses any other, so a schema never means
// more than this code checks. No $ref, no remote fetching, no patterns.

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "examples", "default", "$comment"]);
const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "anyOf", "allOf", "oneOf"]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

export function checkSchema(schema, path = "#", depth = 0) {
  if (depth > 32) throw new Error(`schema ${path}: nested too deeply`);
  if (typeof schema === "boolean") return;
  if (!isObject(schema)) throw new Error(`schema ${path}: must be an object or boolean`);
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new Error(`schema ${path}: keyword "${k}" is not supported by this verifier`);
  }
  if ("type" in schema) for (const t of [schema.type].flat()) if (!TYPES.has(t)) throw new Error(`schema ${path}: unknown type`);
  if ("properties" in schema) {
    if (!isObject(schema.properties)) throw new Error(`schema ${path}: properties must be an object`);
    for (const [k, v] of Object.entries(schema.properties)) checkSchema(v, `${path}/properties/${k}`, depth + 1);
  }
  if ("required" in schema && !(Array.isArray(schema.required) && schema.required.every((r) => typeof r === "string"))) throw new Error(`schema ${path}: required must be a list of names`);
  if ("additionalProperties" in schema) checkSchema(schema.additionalProperties, `${path}/additionalProperties`, depth + 1);
  if ("items" in schema) checkSchema(schema.items, `${path}/items`, depth + 1);
  if ("enum" in schema && !Array.isArray(schema.enum)) throw new Error(`schema ${path}: enum must be a list`);
  for (const k of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) if (k in schema && typeof schema[k] !== "number") throw new Error(`schema ${path}: ${k} must be a number`);
  for (const k of ["anyOf", "allOf", "oneOf"]) {
    if (!(k in schema)) continue;
    if (!Array.isArray(schema[k]) || schema[k].length === 0) throw new Error(`schema ${path}: ${k} must be a non-empty list`);
    schema[k].forEach((s, i) => checkSchema(s, `${path}/${k}/${i}`, depth + 1));
  }
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Returns a list of problems; empty means valid. Call checkSchema first.
export function validate(schema, value, path = "$") {
  if (schema === true) return [];
  if (schema === false) return [`${path}: nothing is allowed here`];
  const errors = [];
  if ("type" in schema) {
    const t = typeOf(value);
    const allowed = [schema.type].flat();
    if (!allowed.includes(t) && !(t === "integer" && allowed.includes("number"))) errors.push(`${path}: expected ${allowed.join(" or ")}, got ${t}`);
  }
  if ("const" in schema && !equal(schema.const, value)) errors.push(`${path}: not the required value`);
  if ("enum" in schema && !schema.enum.some((e) => equal(e, value))) errors.push(`${path}: not one of the allowed values`);
  if (typeof value === "number") {
    if ("minimum" in schema && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if ("maximum" in schema && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (typeof value === "string") {
    const n = [...value].length;
    if ("minLength" in schema && n < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if ("maxLength" in schema && n > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value)) {
    if ("minItems" in schema && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if ("maxItems" in schema && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if ("items" in schema) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (isObject(value)) {
    for (const r of schema.required ?? []) if (!Object.hasOwn(value, r)) errors.push(`${path}: missing "${r}"`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) errors.push(...validate(props[k], v, `${path}.${k}`));
      else if ("additionalProperties" in schema) errors.push(...validate(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  if ("allOf" in schema) for (const s of schema.allOf) errors.push(...validate(s, value, path));
  if ("anyOf" in schema && !schema.anyOf.some((s) => validate(s, value, path).length === 0)) errors.push(`${path}: matches none of the alternatives`);
  if ("oneOf" in schema && schema.oneOf.filter((s) => validate(s, value, path).length === 0).length !== 1) errors.push(`${path}: must match exactly one alternative`);
  return errors;
}

// ---- reading the tree as data ----

// A path inside the tree, or an error. Symlinks are refused: a link could make
// "the file at the bound path" mean a file somewhere else.
function inside(tree, rel) {
  if (typeof rel !== "string" || rel === "" || rel.startsWith("/") || rel.includes("\\") || rel.split("/").some((s) => s === ".." || s === "." || s === "")) throw new Error(`bad path "${rel}"`);
  const root = realpathSync(tree);
  let at = root;
  for (const part of rel.split("/")) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) throw new Error(`${rel} is missing`);
    if (st.isSymbolicLink()) throw new Error(`${rel} goes through a symlink`);
  }
  if (!at.startsWith(root + sep)) throw new Error(`bad path "${rel}"`);
  return at;
}

function readFile(tree, rel) {
  const p = inside(tree, rel);
  const st = lstatSync(p);
  if (!st.isFile()) throw new Error(`${rel} is not a regular file`);
  if (st.size > MAX_FILE) throw new Error(`${rel} is larger than ${MAX_FILE} bytes`);
  return readFileSync(p);
}

function listFiles(tree, rel) {
  const p = inside(tree, rel);
  if (!lstatSync(p).isDirectory()) throw new Error(`${rel} is not a directory`);
  const names = readdirSync(p).filter((n) => n.endsWith(".json")).sort();
  if (names.length > MAX_FILES) throw new Error(`${rel} holds more than ${MAX_FILES} files`);
  return names.map((n) => `${rel}/${n}`);
}

export function parseTrust(raw) {
  const t = JSON.parse(raw);
  if (!isObject(t) || t.v !== 1) throw new Error("trust file: unsupported version");
  if (!sortedPair(t.parties)) throw new Error("trust file: parties must be the two root keys, sorted");
  if (!Array.isArray(t.bindings) || t.bindings.length === 0) throw new Error("trust file: needs at least one binding");
  for (const b of t.bindings) {
    if (!isObject(b) || typeof b.part !== "string" || typeof b.path !== "string") throw new Error("trust file: a binding needs part and path");
    if (b.fixtures !== undefined && (!isObject(b.fixtures) || typeof b.fixtures.valid !== "string" || typeof b.fixtures.invalid !== "string")) throw new Error("trust file: fixtures needs valid and invalid directories");
  }
  if (t.threads !== undefined && !(Array.isArray(t.threads) && t.threads.every(isKey))) throw new Error("trust file: threads must be genesis hashes");
  return t;
}

// The whole check. `trustRaw` is the trust file's bytes from the base branch.
export function verifyTree(tree, trustRaw) {
  const checks = [];
  const add = (ok, what, detail = "") => checks.push({ ok, what, detail });
  let trust;
  try {
    trust = parseTrust(trustRaw);
  } catch (e) {
    add(false, "trust file", e.message);
    return report(checks, trustRaw, null);
  }

  // Agreements signed by exactly the pinned parties, in a pinned thread if any are pinned.
  const agreements = [];
  let files = [];
  try {
    files = listFiles(tree, ".counterpart/agreements");
  } catch (e) {
    add(false, "agreements", e.message);
  }
  for (const f of files) {
    try {
      const a = verifyAgreement(JSON.parse(readFile(tree, f).toString("utf8")));
      if (a.contract.parties.join() !== trust.parties.join()) throw new Error("signed by people this repo does not trust");
      if (trust.threads && !trust.threads.includes(a.genesisHash)) throw new Error("from a thread this repo does not trust");
      agreements.push({ file: f, ...a });
      add(true, `agreement ${f}`, `contract ${a.contractHash}, proposal ${a.proposalId}`);
    } catch (e) {
      add(false, `agreement ${f}`, e.message);
    }
  }
  if (files.length === 0 && !checks.some((c) => !c.ok)) add(false, "agreements", "no agreement in .counterpart/agreements");

  // Every binding the base branch requires must be met by a signed part.
  for (const b of trust.bindings) {
    const label = `binding ${b.part} -> ${b.path}`;
    const holders = agreements.filter((a) => a.contract.parts.some((p) => p.name === b.part));
    if (holders.length === 0) {
      add(false, label, "no trusted agreement contains this part");
      continue;
    }
    let bytes;
    try {
      bytes = readFile(tree, b.path);
    } catch (e) {
      add(false, label, e.message);
      continue;
    }
    const match = holders.find((a) => Buffer.from(a.contract.parts.find((p) => p.name === b.part).content, "utf8").equals(bytes));
    if (!match) {
      add(false, label, `the file (sha256 ${hex(bytes).slice(0, 16)}) is not the text that was signed`);
      continue;
    }
    add(true, label, `identical to the part signed in ${match.file} (sha256 ${hex(bytes).slice(0, 16)})`);
    if (!b.fixtures) continue;

    let schema;
    try {
      schema = JSON.parse(bytes.toString("utf8"));
      checkSchema(schema);
    } catch (e) {
      add(false, `fixtures for ${b.part}`, e.message);
      continue;
    }
    for (const [kind, dir] of [["valid", b.fixtures.valid], ["invalid", b.fixtures.invalid]]) {
      let list;
      try {
        list = listFiles(tree, dir);
      } catch (e) {
        add(false, `${kind} fixtures for ${b.part}`, e.message);
        continue;
      }
      if (list.length === 0) add(false, `${kind} fixtures for ${b.part}`, `${dir} has no .json files`);
      for (const f of list) {
        try {
          const problems = validate(schema, JSON.parse(readFile(tree, f).toString("utf8")));
          if (kind === "valid") add(problems.length === 0, `fixture ${f}`, problems.length ? `should satisfy the agreed schema: ${problems[0]}` : "satisfies the agreed schema");
          else add(problems.length > 0, `fixture ${f}`, problems.length ? `rejected by the agreed schema, as it should be: ${problems[0]}` : "should be rejected by the agreed schema but is accepted");
        } catch (e) {
          add(false, `fixture ${f}`, e.message);
        }
      }
    }
  }
  return report(checks, trustRaw, trust);
}

function report(checks, trustRaw, trust) {
  return {
    ok: checks.length > 0 && checks.every((c) => c.ok),
    verifier: VERIFIER_VERSION,
    trustPolicyHash: hex(trustRaw),
    bindingsHash: trust ? hex(canonicalize(trust.bindings)) : null,
    checks,
  };
}

// Printed text is one line per check with control characters removed: the
// details quote file names and schema messages from the tree under review.
const clean = (s) => String(s).replace(/[^\x20-\x7e]/g, "?");

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tree = arg("--tree");
  const trustPath = arg("--trust");
  if (!tree || !trustPath) {
    console.error("usage: node verify.mjs --tree <checkout> --trust <trust.json from the base branch> [--json]");
    return 2;
  }
  const result = verifyTree(resolve(tree), readFileSync(trustPath));
  if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    for (const c of result.checks) console.log(`${c.ok ? "ok  " : "FAIL"}  ${clean(c.what)}${c.detail ? `: ${clean(c.detail)}` : ""}`);
    console.log(result.ok ? "\nThis tree carries what both people signed." : "\nVerification failed.");
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
