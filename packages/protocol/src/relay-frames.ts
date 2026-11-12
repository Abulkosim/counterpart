import type { DeviceCredential } from "./identity.ts";
import type { Wire } from "./envelope.ts";

// JSON frames on the relay WebSocket. The relay never sees plaintext.
export type ServerFrame =
  | { t: "challenge"; nonce: string }
  | { t: "ready"; device: string }
  | { t: "stored"; id: string }
  | { t: "deliver"; wire: Wire }
  | { t: "error"; code: string; id?: string; message?: string };

export type ClientFrame =
  | { t: "auth"; credential: DeviceCredential; sig: string }
  | { t: "send"; wire: Wire }
  | { t: "ack"; id: string };

export const RELAY_AUTH_DOMAIN = "relay-auth/v1";
