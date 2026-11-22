// Nameplates: the number in a short pairing code. Each is a small mailbox
// between the device that opened it (the inviter) and the first device that
// claims it (the joiner). The relay passes messages between them and never
// sees the code's words. It is not trusted to: the two daemons check
// everything. What the relay adds is that a number can be claimed once, expires
// after ten minutes, and that one person can open and claim only a few.
//
// The limits count per device, per root key and per source address. Device
// credentials cost nothing to make, so a device limit alone does not bound one
// person. Root keys cost nothing either on an open relay; there the address
// limit does the work, except for loopback addresses, which a tunnel gives
// every connection. Claims of a number nobody opened count double: that is
// what scanning looks like. When there is a lot of it, new codes get numbers
// up to 9999, which are much harder to hit.
//
// Kept in memory. A relay restart ends every pairing in progress; people make a
// new code.
import { type PairClientFrame, type PairServerFrame, PAIR_BODY_MAX, NAMEPLATE_MAX, isObject, isStr } from "@counterpart/protocol";

export interface NameplateOptions {
  now?: () => number;
  ttlMs?: number; // how long a nameplate lives
  cooldownMs?: number; // how long a number rests after it is closed or expires
  opensPerHour?: number; // per device and per root key
  openAtOnce?: number; // per device and per root key
  claimsPerHour?: number; // per device and per root key
  perAddressPerHour?: number; // opens, and claims, per source address
  scanLimit?: number; // claims of unknown numbers, relay-wide, per 10 minutes, before codes get long numbers
  maxPlates?: number; // relay-wide
  maxMessages?: number; // per side, per nameplate
  deliver: (device: string, frame: PairServerFrame) => void;
  log?: (line: string) => void;
}

// Who sent a frame, as the relay saw the login.
export interface PairOrigin {
  root?: string;
  addr?: string;
}

interface Plate {
  owner: string;
  ownerRoot: string | undefined;
  claimer: string | null;
  expiresAt: number;
  msgs: { from: "inviter" | "joiner"; n: number; body: string }[];
}

export interface Nameplates {
  handle(device: string, frame: PairClientFrame, origin?: PairOrigin): void;
  // A device has logged in: send it everything waiting for it.
  online(device: string): void;
  sweep(): void;
  count(): number;
  close(): void;
}

export function nameplates(opts: NameplateOptions): Nameplates {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const cooldown = opts.cooldownMs ?? 30 * 60_000;
  const opensPerHour = opts.opensPerHour ?? 10;
  const openAtOnce = opts.openAtOnce ?? 3;
  const claimsPerHour = opts.claimsPerHour ?? 10;
  const perAddress = opts.perAddressPerHour ?? 30;
  const scanLimit = opts.scanLimit ?? 30;
  const maxPlates = opts.maxPlates ?? 5000;
  const maxMessages = opts.maxMessages ?? 4;
  const log = opts.log ?? (() => {});
  const plates = new Map<number, Plate>();
  const resting = new Map<number, number>(); // number -> until
  // Limit key (see `keys`) -> times of use in the last hour.
  const opens = new Map<string, number[]>();
  const claims = new Map<string, number[]>();
  let misses: number[] = []; // claims of unknown numbers, relay-wide
  const deliver = opts.deliver;

  const err = (device: string, code: string, extra: { ref?: string; nameplate?: number } = {}): void => deliver(device, { t: "pair.error", code, ...extra });

  // Times within the last hour, pruned. The map is bounded so many throwaway
  // devices cannot grow it without limit.
  const recent = (m: Map<string, number[]>, key: string): number[] => {
    const t = now();
    const list = (m.get(key) ?? []).filter((x) => x > t - 3600_000);
    m.delete(key);
    m.set(key, list);
    if (m.size > 50_000) m.delete(m.keys().next().value!);
    return list;
  };

  const end = (n: number, why: "closed" | "expired", by?: string): void => {
    const p = plates.get(n);
    if (!p) return;
    plates.delete(n);
    resting.set(n, now() + cooldown);
    for (const d of [p.owner, p.claimer]) if (d && d !== by) deliver(d, { t: "pair.closed", nameplate: n, why });
  };

  const sweep = (): void => {
    const t = now();
    for (const [n, p] of plates) if (p.expiresAt <= t) end(n, "expired");
    for (const [n, until] of resting) if (until <= t) resting.delete(n);
  };

  // A free number, short when the relay is quiet: from 1-99 while fewer than
  // half of those are taken, then 1-999, then 1-9999. Random within the range,
  // so the next number cannot be predicted from the last.
  const allocate = (): number | null => {
    const t = now();
    misses = misses.filter((x) => x > t - 10 * 60_000);
    for (const top of misses.length >= scanLimit ? [NAMEPLATE_MAX] : [99, 999, NAMEPLATE_MAX]) {
      const free: number[] = [];
      for (let n = 1; n <= top; n++) if (!plates.has(n) && !resting.has(n)) free.push(n);
      if (free.length > (top === NAMEPLATE_MAX ? 0 : top / 2)) return free[Math.floor(Math.random() * free.length)]!;
    }
    return null;
  };

  const role = (p: Plate, device: string): "inviter" | "joiner" | null => (p.owner === device ? "inviter" : p.claimer === device ? "joiner" : null);
  const sendAll = (n: number, p: Plate, to: string): void => {
    const mine = role(p, to);
    for (const m of p.msgs) if (m.from !== mine) deliver(to, { t: "pair.msg", nameplate: n, ...m });
  };

  // The keys a frame counts against, each with its hourly limit.
  const loopback = (a: string): boolean => a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
  const keys = (device: string, o: PairOrigin, perHour: number): [string, number][] => [
    [`d:${device}`, perHour],
    ...(o.root ? [[`r:${o.root}`, perHour] as [string, number]] : []),
    ...(o.addr && !loopback(o.addr) ? [[`a:${o.addr}`, perAddress] as [string, number]] : []),
  ];
  // The lists to count a use in, or null when any key is at its limit.
  const limited = (m: Map<string, number[]>, ks: [string, number][]): number[][] | null => {
    const lists = ks.map(([k, max]) => ({ l: recent(m, k), max }));
    return lists.some((x) => x.l.length >= x.max) ? null : lists.map((x) => x.l);
  };
  const use = (lists: number[][], weight: number): void => {
    for (const l of lists) for (let i = 0; i < weight; i++) l.push(now());
  };

  const timer = setInterval(sweep, 5_000);
  timer.unref();

  return {
    handle(device, frame, origin = {}) {
      sweep();
      const f = frame as unknown as Record<string, unknown>;
      if (!isObject(f)) return;
      if (f.t === "pair.open") {
        const ref = f.ref;
        if (!isStr(ref, 1, 64) || !/^[A-Za-z0-9_-]+$/.test(ref)) return err(device, "bad_frame");
        const lists = limited(opens, keys(device, origin, opensPerHour));
        const mine = [...plates.values()].filter((p) => p.owner === device || (origin.root !== undefined && p.ownerRoot === origin.root)).length;
        if (!lists || mine >= openAtOnce) return err(device, "rate_limited", { ref });
        if (plates.size >= maxPlates) return err(device, "relay_full", { ref });
        const n = allocate();
        if (n === null) return err(device, "relay_full", { ref });
        use(lists, 1);
        const expiresAt = now() + ttl;
        plates.set(n, { owner: device, ownerRoot: origin.root, claimer: null, expiresAt, msgs: [] });
        log(`nameplate ${n} opened`);
        return deliver(device, { t: "pair.opened", ref, nameplate: n, expiresAt });
      }
      const n = f.nameplate;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > NAMEPLATE_MAX) return err(device, "bad_frame");
      const p = plates.get(n);
      if (f.t === "pair.claim") {
        const lists = limited(claims, keys(device, origin, claimsPerHour));
        if (!lists) return err(device, "rate_limited", { nameplate: n });
        if (!p) {
          use(lists, 2);
          misses.push(now());
          if (misses.length > 10_000) misses.shift();
          return err(device, "nameplate_unknown", { nameplate: n });
        }
        use(lists, 1);
        if (p.owner === device) return err(device, "nameplate_own", { nameplate: n });
        if (p.claimer === device) return sendAll(n, p, device);
        if (p.claimer) return err(device, "nameplate_taken", { nameplate: n });
        p.claimer = device;
        deliver(device, { t: "pair.claimed", nameplate: n, expiresAt: p.expiresAt });
        deliver(p.owner, { t: "pair.joined", nameplate: n });
        return sendAll(n, p, device);
      }
      if (!p) return err(device, "nameplate_unknown", { nameplate: n });
      const from = role(p, device);
      if (!from) return err(device, "nameplate_not_yours", { nameplate: n });
      if (f.t === "pair.send") {
        if (!isStr(f.body, 1, PAIR_BODY_MAX)) return err(device, "bad_frame", { nameplate: n });
        // A client sends again after a reconnect. The same message twice is one message.
        if (p.msgs.some((m) => m.from === from && m.body === f.body)) return;
        const count = p.msgs.filter((m) => m.from === from).length;
        if (count >= maxMessages) return err(device, "too_many_messages", { nameplate: n });
        const m = { from, n: count, body: f.body };
        p.msgs.push(m);
        const to = from === "inviter" ? p.claimer : p.owner;
        if (to) deliver(to, { t: "pair.msg", nameplate: n, ...m });
        return;
      }
      if (f.t === "pair.close") return end(n, "closed", device);
      return err(device, "bad_frame", { nameplate: n });
    },
    online(device) {
      sweep();
      for (const [n, p] of plates) if (role(p, device)) sendAll(n, p, device);
    },
    sweep,
    count: () => plates.size,
    close: () => clearInterval(timer),
  };
}
