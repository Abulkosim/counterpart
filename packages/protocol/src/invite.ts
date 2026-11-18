import { b64u, unb64u } from "./bytes.ts";
import { canonicalBytes, parseCanonical } from "./canonical.ts";
import { isId, isInt, isObject, isStr, onlyKeys } from "./check.ts";
import { type DeviceCredential, verifyCredential } from "./identity.ts";
import { isRelayUrl } from "./relays.ts";

// Handed to the other human out of band. The token is single use and proves the
// request came from whoever received the invite.
export interface Invite {
  v: 1;
  relay: string;
  credential: DeviceCredential;
  token: string;
  expiresAt: number;
}

const PREFIX = "cpart-invite:";

export const encodeInvite = (i: Invite): string => PREFIX + b64u(canonicalBytes(i));

export function decodeInvite(s: string, now = Date.now()): Invite {
  if (!s.startsWith(PREFIX)) throw new Error("invite: not an invite");
  const x = parseCanonical(unb64u(s.slice(PREFIX.length).trim()));
  if (!isObject(x) || !onlyKeys(x, ["v", "relay", "credential", "token", "expiresAt"])) throw new Error("invite: shape");
  if (x.v !== 1 || !isStr(x.relay, 1, 512) || !isId(x.token) || !isInt(x.expiresAt)) throw new Error("invite: fields");
  // The address is shown to a person, stored, and printed in commands to run.
  if (!isRelayUrl(x.relay)) throw new Error("invite: relay must be a plain ws:// or wss:// address");
  if (x.expiresAt <= now) throw new Error("invite: expired");
  return { v: 1, relay: x.relay, credential: verifyCredential(x.credential, now), token: x.token, expiresAt: x.expiresAt };
}
