// Relay addresses as they appear in invites, relay lists and logins.

export const RELAY_LIMITS = {
  url: 512,
  // Names one person announces for all their relays together. A relay can have
  // more than one name: the address one machine dials and the one another does.
  names: 16,
} as const;

// A plain ws:// or wss:// address: a host name or IP address, an optional port
// and path, nothing else. Contacts choose these and they are printed as part of
// commands to run (`cpart relay add <url>`), so only characters that mean
// nothing to a shell: letters, digits and . - _ ~ / % (and [ ] : for IPv6).
const PLAIN = /^wss?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/i;

export function isRelayUrl(x: unknown): x is string {
  if (typeof x !== "string" || x.length < 1 || x.length > RELAY_LIMITS.url) return false;
  if (!PLAIN.test(x)) return false;
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
