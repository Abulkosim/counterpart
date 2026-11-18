import { isId, isInt, isKey, isObject, isStr, onlyKeys } from "./check.ts";
import { type Approval, type Contract, CONTRACT_LIMITS, parseApproval, parseContract } from "./contract.ts";
import { type Evidence, parseEvidence } from "./evidence.ts";
import { RELAY_LIMITS, isRelayUrl, relayKey } from "./relays.ts";

// One entry in a thread's log. Events form a DAG through `parents`; there is no
// global order. `lane` separates free talk from control traffic; the act lane
// holds typed operations: only these change what has been agreed.
export type Lane = "control" | "talk" | "act";

export interface EventBodies {
  "contact.request": { token: string };
  "contact.accepted": Record<string, never>;
  // Carries nothing. Its envelope delivers the sender's renewed device credential.
  "contact.hello": Record<string, never>;
  // The relays the sender can be reached on, most preferred first. `version`
  // only grows; an older list is never applied over a newer one. `seen` is the
  // version of the recipient's own list the sender holds, which confirms it.
  "contact.relays": { relays: string[]; version: number; seen: number };
  "thread.opened": { goal: string; participants: string[] };
  // Asks the other side to send again events it authored in this thread that
  // never arrived here. Not part of the thread's log: sequence 0, no parents.
  "thread.resend": { ids: string[] };
  // Says which of the other side's events in this thread were applied here.
  // Not part of the log either. It is the sender's claim, nothing more.
  "thread.received": { ids: string[] };
  // `via` says who on the sender's side wrote it. It is the sender's own claim.
  "talk.posted": { text: string; via?: Via };
  // Proposals are addressed by the id of the event that made them, never by
  // contract hash alone: the same text can be proposed twice, and consent to
  // one proposal is not consent to the other.
  "contract.proposed": { contract: Contract; supersedes?: string };
  "contract.accepted": { approval: Approval };
  "contract.declined": { proposalId: string; reason?: string };
  "contract.withdrawn": { proposalId: string };
  // One side's account of its own repository after publishing. A claim, not a
  // fact: the receiver recomputes what it can from the agreed contract.
  "evidence.posted": Evidence;
}

export type Via = "human" | "agent" | "frontdesk";
const VIAS: readonly unknown[] = ["human", "agent", "frontdesk"];

export type EventType = keyof EventBodies;

export interface ThreadEvent<T extends EventType = EventType> {
  id: string;
  threadId: string;
  author: string; // device id
  authorSeq: number; // per author device, per thread, starting at 0
  parents: string[];
  lane: Lane;
  type: T;
  body: EventBodies[T];
  createdAt: number;
}

export const LIMITS = {
  goal: 2000,
  text: 16000,
  parents: 16,
  participants: 8,
  resendIds: 16,
  receiptIds: 64,
  wireBytes: 256 * 1024,
  maxTtlMs: 7 * 24 * 3600 * 1000,
} as const;

const lanes: Record<EventType, Lane> = {
  "contact.request": "control",
  "contact.accepted": "control",
  "contact.hello": "control",
  "contact.relays": "control",
  "thread.opened": "control",
  "thread.resend": "control",
  "thread.received": "control",
  "talk.posted": "talk",
  "contract.proposed": "act",
  "contract.accepted": "act",
  "contract.declined": "act",
  "contract.withdrawn": "act",
  "evidence.posted": "act",
};

const bodies: { [T in EventType]: (b: Record<string, unknown>) => boolean } = {
  "contact.request": (b) => onlyKeys(b, ["token"]) && isId(b.token),
  "contact.accepted": (b) => onlyKeys(b, []),
  "contact.hello": (b) => onlyKeys(b, []),
  "contact.relays": (b) =>
    onlyKeys(b, ["relays", "version", "seen"]) &&
    isInt(b.version) &&
    isInt(b.seen) &&
    Array.isArray(b.relays) &&
    b.relays.length >= 1 &&
    b.relays.length <= RELAY_LIMITS.names &&
    b.relays.every(isRelayUrl) &&
    new Set(b.relays.map((r: string) => relayKey(r))).size === b.relays.length,
  "thread.opened": (b) =>
    onlyKeys(b, ["goal", "participants"]) &&
    isStr(b.goal, 0, LIMITS.goal) &&
    Array.isArray(b.participants) &&
    b.participants.length >= 2 &&
    b.participants.length <= LIMITS.participants &&
    b.participants.every(isKey) &&
    new Set(b.participants).size === b.participants.length,
  "thread.resend": (b) => onlyKeys(b, ["ids"]) && idList(b.ids, LIMITS.resendIds),
  "thread.received": (b) => onlyKeys(b, ["ids"]) && idList(b.ids, LIMITS.receiptIds),
  "talk.posted": (b) => isStr(b.text, 1, LIMITS.text) && (onlyKeys(b, ["text"]) || (onlyKeys(b, ["text", "via"]) && VIAS.includes(b.via))),
  "contract.proposed": (b) => (onlyKeys(b, ["contract"]) || (onlyKeys(b, ["contract", "supersedes"]) && isId(b.supersedes))) && ok(() => parseContract(b.contract)),
  "contract.accepted": (b) => onlyKeys(b, ["approval"]) && ok(() => parseApproval(b.approval)),
  "contract.declined": (b) => isId(b.proposalId) && (onlyKeys(b, ["proposalId"]) || (onlyKeys(b, ["proposalId", "reason"]) && isStr(b.reason, 1, CONTRACT_LIMITS.reason))),
  "contract.withdrawn": (b) => onlyKeys(b, ["proposalId"]) && isId(b.proposalId),
  "evidence.posted": (b) => ok(() => parseEvidence(b)),
};

const idList = (x: unknown, max: number): boolean => Array.isArray(x) && x.length >= 1 && x.length <= max && x.every(isId) && new Set(x).size === x.length;

function ok(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

const FIELDS = ["id", "threadId", "author", "authorSeq", "parents", "lane", "type", "body", "createdAt"] as const;

export function parseEvent(x: unknown): ThreadEvent {
  if (!isObject(x) || !onlyKeys(x, FIELDS)) throw new Error("event: shape");
  const { id, threadId, author, authorSeq, parents, lane, type, body, createdAt } = x;
  if (!isId(id) || !isId(threadId) || !isStr(author, 24, 24) || !author.startsWith("d_")) throw new Error("event: ids");
  if (!isInt(authorSeq) || !isInt(createdAt)) throw new Error("event: numbers");
  if (!Array.isArray(parents) || parents.length > LIMITS.parents || !parents.every(isId) || new Set(parents).size !== parents.length)
    throw new Error("event: parents");
  if (!isStr(type) || !Object.hasOwn(bodies, type)) throw new Error("event: unknown type");
  const t = type as EventType;
  if (lane !== lanes[t]) throw new Error("event: wrong lane for type");
  if (!isObject(body) || !bodies[t](body)) throw new Error(`event: bad ${t} body`);
  return { id, threadId, author, authorSeq, parents: parents as string[], lane: lanes[t], type: t, body: body as never, createdAt };
}

export const laneOf = (type: EventType): Lane => lanes[type];
