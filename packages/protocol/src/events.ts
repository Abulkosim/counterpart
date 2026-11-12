import { isId, isInt, isKey, isObject, isStr, onlyKeys } from "./check.ts";

// One entry in a thread's log. Events form a DAG through `parents`; there is no
// global order. `lane` separates free talk from control traffic; the act lane
// (typed, grant-checked operations) arrives with contracts.
export type Lane = "control" | "talk";

export interface EventBodies {
  "contact.request": { token: string };
  "contact.accepted": Record<string, never>;
  // Carries nothing. Its envelope delivers the sender's renewed device credential.
  "contact.hello": Record<string, never>;
  "thread.opened": { goal: string; participants: string[] };
  // `via` says who on the sender's side wrote it. It is the sender's own claim.
  "talk.posted": { text: string; via?: Via };
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
  wireBytes: 256 * 1024,
  maxTtlMs: 7 * 24 * 3600 * 1000,
} as const;

const lanes: Record<EventType, Lane> = {
  "contact.request": "control",
  "contact.accepted": "control",
  "contact.hello": "control",
  "thread.opened": "control",
  "talk.posted": "talk",
};

const bodies: { [T in EventType]: (b: Record<string, unknown>) => boolean } = {
  "contact.request": (b) => onlyKeys(b, ["token"]) && isId(b.token),
  "contact.accepted": (b) => onlyKeys(b, []),
  "contact.hello": (b) => onlyKeys(b, []),
  "thread.opened": (b) =>
    onlyKeys(b, ["goal", "participants"]) &&
    isStr(b.goal, 0, LIMITS.goal) &&
    Array.isArray(b.participants) &&
    b.participants.length >= 2 &&
    b.participants.length <= LIMITS.participants &&
    b.participants.every(isKey) &&
    new Set(b.participants).size === b.participants.length,
  "talk.posted": (b) => isStr(b.text, 1, LIMITS.text) && (onlyKeys(b, ["text"]) || (onlyKeys(b, ["text", "via"]) && VIAS.includes(b.via))),
};

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
