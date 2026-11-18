import { canonicalBytes } from "./canonical.ts";
import type { DeviceCredential } from "./identity.ts";
import type { Wire } from "./envelope.ts";

// JSON frames on the relay WebSocket. The relay never sees plaintext.
export type ServerFrame =
  | { t: "challenge"; nonce: string }
  // `features` lists what this relay does beyond the first version. "ping":
  // it answers a ping frame with a pong. `id`: the same for every name the
  // relay answers to (it is also in /healthz).
  | { t: "ready"; device: string; features?: string[]; id?: string }
  | { t: "pong"; n: number }
  | { t: "stored"; id: string }
  | { t: "deliver"; wire: Wire }
  | { t: "error"; code: string; id?: string; message?: string }
  | PairServerFrame;

export type ClientFrame =
  // `relay` is the URL the client dialled. Signing it stops one relay replaying
  // a client's login to another.
  | { t: "auth"; credential: DeviceCredential; relay: string; sig: string }
  | { t: "send"; wire: Wire }
  // `ok` is true when the message was accepted, false or absent when it was refused.
  | { t: "ack"; id: string; ok?: boolean }
  // Only to a relay whose ready frame listed "ping". Older relays close the
  // connection on frames they do not know.
  | { t: "ping"; n: number }
  | PairClientFrame;

export const RELAY_AUTH_DOMAIN = "relay-auth/v1";

export const relayAuthMessage = (nonce: string, relay: string): Uint8Array => canonicalBytes({ nonce, relay });

// Nameplates: short-lived mailboxes for pairing with a short code
// (pake-pairing.ts, docs/pairing.md). Only logged-in devices use them. The
// relay never sees the code's words, only its number.
export type PairClientFrame =
  // `ref` is the client's own label for the request, echoed back.
  | { t: "pair.open"; ref: string }
  | { t: "pair.claim"; nameplate: number }
  | { t: "pair.send"; nameplate: number; body: string }
  | { t: "pair.close"; nameplate: number };

export type PairServerFrame =
  | { t: "pair.opened"; ref: string; nameplate: number; expiresAt: number }
  | { t: "pair.claimed"; nameplate: number; expiresAt: number } // to the joiner
  | { t: "pair.joined"; nameplate: number } // to the inviter: someone claimed it
  // `from`: who wrote it. `n`: its index among that side's messages.
  | { t: "pair.msg"; nameplate: number; from: "inviter" | "joiner"; n: number; body: string }
  | { t: "pair.closed"; nameplate: number; why: "closed" | "expired" }
  | { t: "pair.error"; code: string; ref?: string; nameplate?: number };

export const isPairFrame = (t: unknown): t is `pair.${string}` => typeof t === "string" && t.startsWith("pair.");
