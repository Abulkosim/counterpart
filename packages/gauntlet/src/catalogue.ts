import { authority } from "./cases/authority.ts";
import { envelope } from "./cases/envelope.ts";
import { evidence } from "./cases/evidence.ts";
import { hostileRelay } from "./cases/hostile-relay.ts";
import { model } from "./cases/model.ts";
import { output } from "./cases/output.ts";
import { pairing } from "./cases/pairing.ts";
import { parsing } from "./cases/parsing.ts";
import { relayClients } from "./cases/relay-clients.ts";
import { replay } from "./cases/replay.ts";
import { resend } from "./cases/resend.ts";
import { storage } from "./cases/storage.ts";
import { CATEGORIES, type Case, type ModelCase } from "./types.ts";

export const cases: Case[] = [...envelope, ...parsing, ...replay, ...authority, ...resend, ...evidence, ...hostileRelay, ...relayClients, ...output, ...storage, ...pairing];
export const modelCases: ModelCase[] = model;

// Problems with the catalogue itself, as opposed to with the code under test.
export function problems(list: Case[] = cases): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (seen.has(c.id)) out.push(`${c.id}: duplicate id`);
    seen.add(c.id);
    if (!(c.category in CATEGORIES)) out.push(`${c.id}: unknown category`);
    if (!c.title || !c.claim.endsWith(".")) out.push(`${c.id}: needs a title and a claim that is one sentence`);
    if (!!c.knownFailure !== !!c.finding) out.push(`${c.id}: knownFailure and finding go together`);
  }
  return out;
}
