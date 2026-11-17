import { canonicalBytes } from "./canonical.ts";
import type { DeviceCredential } from "./identity.ts";
import type { Wire } from "./envelope.ts";

// JSON frames on the relay WebSocket. The relay never sees plaintext.
export type ServerFrame =
  | { t: "challenge"; nonce: string }
  // `features` lists what this relay does beyond the first version. "ping":
  // it answers a ping frame with a pong.
  | { t: "ready"; device: string; features?: string[] }
  | { t: "pong"; n: number }
  | { t: "stored"; id: string }
  | { t: "deliver"; wire: Wire }
  | { t: "error"; code: string; id?: string; message?: string };

export type ClientFrame =
  // `relay` is the URL the client dialled. Signing it stops one relay replaying
  // a client's login to another.
  | { t: "auth"; credential: DeviceCredential; relay: string; sig: string }
  | { t: "send"; wire: Wire }
  // `ok` is true when the message was accepted, false or absent when it was refused.
  | { t: "ack"; id: string; ok?: boolean }
  // Only to a relay whose ready frame listed "ping". Older relays close the
  // connection on frames they do not know.
  | { t: "ping"; n: number };

export const RELAY_AUTH_DOMAIN = "relay-auth/v1";

export const relayAuthMessage = (nonce: string, relay: string): Uint8Array => canonicalBytes({ nonce, relay });
