// Relay addresses as they appear in invites, relay lists and logins.

export const RELAY_LIMITS = {
  url: 512,
  // Names one person announces for all their relays together. A relay can have
  // more than one name: the address one machine dials and the one another does.
  names: 16,
} as const;

// A plain ws:// or wss:// address: a host, an optional port and path, nothing
// else. It is shown to people and stored, so nothing invisible either.
export function isRelayUrl(x: unknown): x is string {
  if (typeof x !== "string" || x.length < 1 || x.length > RELAY_LIMITS.url) return false;
  if (!/^[\x21-\x7e]+$/.test(x) || /[#?@\\]/.test(x)) return false;
  let u: URL;
  try {
    u = new URL(x);
  } catch {
    return false;
  }
  return (u.protocol === "ws:" || u.protocol === "wss:") && u.hostname !== "" && !u.username && !u.password && !u.search && !u.hash;
}

// One spelling per address, so "ws://Host:80/" and "ws://host" compare equal.
// The URL parser lowercases the host and drops a default port.
export function relayKey(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
}
