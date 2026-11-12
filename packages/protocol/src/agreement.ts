import { isId, isKey, isObject, onlyKeys } from "./check.ts";
import { type Approval, type Contract, contractHash, hashOf, parseContract, verifyApproval } from "./contract.ts";
import { type ThreadEvent, parseEvent } from "./events.ts";

// Both signatures over one proposal of one contract, with what is needed to
// check them offline. A valid file proves that the holders of these two root
// keys approved this text in this thread. It does not prove whose keys they
// are, or that a passphrase was typed: compare the keys with ones you trust.
export interface Agreement {
  v: 1;
  contract: Contract;
  contractHash: string;
  proposalId: string;
  genesis: ThreadEvent; // the thread's first event; approvals sign its hash
  approvals: Approval[];
}

export function verifyAgreement(x: unknown): Agreement {
  if (!isObject(x) || !onlyKeys(x, ["v", "contract", "contractHash", "proposalId", "genesis", "approvals"])) throw new Error("agreement: shape");
  if (x.v !== 1 || !isKey(x.contractHash) || !isId(x.proposalId)) throw new Error("agreement: fields");
  const contract = parseContract(x.contract);
  if (contractHash(contract) !== x.contractHash) throw new Error("agreement: the contract does not match its hash");
  const genesis = parseEvent(x.genesis);
  if (genesis.type !== "thread.opened") throw new Error("agreement: genesis is not a thread opening");
  const participants = [...(genesis as ThreadEvent<"thread.opened">).body.participants].sort();
  if (participants.join() !== contract.parties.join()) throw new Error("agreement: the thread is between different people than the contract");
  const genesisHash = hashOf(genesis);
  if (!Array.isArray(x.approvals) || x.approvals.length !== 2) throw new Error("agreement: needs exactly two approvals");
  const approvals = x.approvals.map(verifyApproval);
  for (const a of approvals) {
    if (a.contractHash !== x.contractHash) throw new Error("agreement: an approval is for a different contract");
    if (a.proposalId !== x.proposalId) throw new Error("agreement: an approval is for a different proposal");
    if (a.threadGenesis !== genesisHash) throw new Error("agreement: an approval is from a different thread");
    if (a.parties.join() !== contract.parties.join()) throw new Error("agreement: an approval names different parties");
  }
  if (approvals.map((a) => a.approver).sort().join() !== contract.parties.join()) throw new Error("agreement: the two approvals must come from the two parties");
  return { v: 1, contract, contractHash: x.contractHash, proposalId: x.proposalId, genesis, approvals };
}
