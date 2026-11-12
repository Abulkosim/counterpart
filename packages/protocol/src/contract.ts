import { b64u, sha256 } from "./bytes.ts";
import { canonicalBytes } from "./canonical.ts";
import { isInt, isKey, isId, isObject, isStr, onlyKeys } from "./check.ts";
import { type KeyPair, sign, verify } from "./keys.ts";

// A contract is the exact thing two people agree to. Its hash covers every
// byte, including attached parts, so "the same contract" has one meaning.
export interface ContractPart {
  kind: "text" | "json-schema" | "openapi";
  name: string;
  content: string;
}
export interface Contract {
  v: 1;
  title: string;
  text: string;
  parties: string[]; // the two root keys, sorted
  parts: ContractPart[];
}

// A person's consent to one exact contract in one exact thread, signed with
// their root key. It cannot be moved to another thread, proposal or contract.
// Approvals are not revocable: withdrawing a proposal stops asking, it does not
// cancel a signature already given.
export interface Approval {
  v: 1;
  threadGenesis: string; // hash of the thread's first event
  proposalId: string; // the event that proposed the contract
  contractHash: string;
  parties: string[];
  approver: string; // root key
  approvedAt: number; // the signer's own clock, not proof of time
  sig: string;
}

export const CONTRACT_LIMITS = { title: 200, text: 32_000, parts: 8, partName: 80, partContent: 64_000, reason: 500 } as const;
const KINDS: readonly unknown[] = ["text", "json-schema", "openapi"];
const PART_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DOMAIN = "approval/v1";

export const hashOf = (value: unknown): string => b64u(sha256(canonicalBytes(value)));
export const contractHash = (c: Contract): string => hashOf(c);

export function parseContract(x: unknown): Contract {
  if (!isObject(x) || !onlyKeys(x, ["v", "title", "text", "parties", "parts"])) throw new Error("contract: shape");
  const { v, title, text, parties, parts } = x;
  if (v !== 1 || !isStr(title, 1, CONTRACT_LIMITS.title) || !isStr(text, 1, CONTRACT_LIMITS.text)) throw new Error("contract: fields");
  if (!Array.isArray(parties) || parties.length !== 2 || !parties.every(isKey) || !((parties[0] as string) < (parties[1] as string))) throw new Error("contract: parties must be two distinct root keys, sorted");
  if (!Array.isArray(parts) || parts.length > CONTRACT_LIMITS.parts) throw new Error("contract: parts");
  const names = new Set<string>();
  const outParts = parts.map((p): ContractPart => {
    if (!isObject(p) || !onlyKeys(p, ["kind", "name", "content"])) throw new Error("contract: part shape");
    if (!KINDS.includes(p.kind) || !isStr(p.name) || !PART_NAME.test(p.name) || !isStr(p.content, 1, CONTRACT_LIMITS.partContent)) throw new Error("contract: part fields");
    if (names.has(p.name)) throw new Error("contract: duplicate part name");
    names.add(p.name);
    if (p.kind === "json-schema") {
      // Syntax only. A schema being present says nothing about whether anyone satisfies it.
      let parsed: unknown;
      try {
        parsed = JSON.parse(p.content);
      } catch {
        throw new Error(`contract: part ${p.name} is not valid JSON`);
      }
      if (!isObject(parsed)) throw new Error(`contract: part ${p.name} must be a JSON object`);
    }
    return { kind: p.kind as ContractPart["kind"], name: p.name, content: p.content };
  });
  return { v: 1, title, text, parties: parties as string[], parts: outParts };
}

type ApprovalFields = Omit<Approval, "sig">;

export function signApproval(root: KeyPair, fields: Omit<ApprovalFields, "v" | "approver">): Approval {
  const body: ApprovalFields = { v: 1, ...fields, approver: root.publicKey };
  return { ...body, sig: sign(root, DOMAIN, canonicalBytes(body)) };
}

export function parseApproval(x: unknown): Approval {
  if (!isObject(x) || !onlyKeys(x, ["v", "threadGenesis", "proposalId", "contractHash", "parties", "approver", "approvedAt", "sig"])) throw new Error("approval: shape");
  const { v, threadGenesis, proposalId, contractHash: h, parties, approver, approvedAt, sig } = x;
  if (v !== 1 || !isKey(threadGenesis) || !isId(proposalId) || !isKey(h) || !isKey(approver) || !isInt(approvedAt) || !isStr(sig, 86, 86)) throw new Error("approval: fields");
  if (!Array.isArray(parties) || parties.length !== 2 || !parties.every(isKey) || !((parties[0] as string) < (parties[1] as string))) throw new Error("approval: parties");
  if (!parties.includes(approver)) throw new Error("approval: approver is not a party");
  return { v: 1, threadGenesis, proposalId, contractHash: h, parties: parties as string[], approver, approvedAt, sig };
}

// Checks the signature only. Whether the approval belongs to this thread,
// proposal and contract is for the caller to check against what it holds.
export function verifyApproval(x: unknown): Approval {
  const a = parseApproval(x);
  const { sig, ...body } = a;
  if (!verify(a.approver, DOMAIN, canonicalBytes(body), sig)) throw new Error("approval: bad signature");
  return a;
}

// Both signatures over one contract, with what is needed to check them offline.
// A valid file proves these two root keys approved this text in this thread. It
// does not prove whose keys they are: compare them with keys you already trust.
export interface Agreement {
  v: 1;
  contract: Contract;
  contractHash: string;
  threadId: string;
  threadGenesis: string;
  approvals: Approval[];
}

export function verifyAgreement(x: unknown): Agreement {
  if (!isObject(x) || !onlyKeys(x, ["v", "contract", "contractHash", "threadId", "threadGenesis", "approvals"])) throw new Error("agreement: shape");
  if (x.v !== 1 || !isKey(x.contractHash) || !isId(x.threadId) || !isKey(x.threadGenesis)) throw new Error("agreement: fields");
  const contract = parseContract(x.contract);
  if (contractHash(contract) !== x.contractHash) throw new Error("agreement: the contract does not match its hash");
  if (!Array.isArray(x.approvals) || x.approvals.length !== 2) throw new Error("agreement: needs exactly two approvals");
  const approvals = x.approvals.map(verifyApproval);
  for (const a of approvals) {
    if (a.contractHash !== x.contractHash) throw new Error("agreement: an approval is for a different contract");
    if (a.threadGenesis !== x.threadGenesis) throw new Error("agreement: an approval is from a different thread");
    if (a.parties.join() !== contract.parties.join()) throw new Error("agreement: an approval names different parties");
  }
  const approvers = approvals.map((a) => a.approver).sort();
  if (approvers.join() !== contract.parties.join()) throw new Error("agreement: the two approvals must come from the two parties");
  return { v: 1, contract, contractHash: x.contractHash, threadId: x.threadId, threadGenesis: x.threadGenesis, approvals };
}
