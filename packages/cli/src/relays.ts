// `cpart relay add|remove|move|list`, what the daemon prints about its
// connections, and finding a relay from inside a container.
import { existsSync } from "node:fs";
import type { Counterpart, RelayLink } from "@counterpart/daemon";
import { isRelayUrl, relayKey } from "@counterpart/protocol";

export const RELAY_SUBCOMMANDS = ["add", "remove", "move", "list"];

export const RELAY_USAGE = `  cpart relay list                                                your relays, and which contacts know your current list
  cpart relay add <url> [--as <url>]                              use another relay too. Contacts are told. --as: the address
                                                                  others use for the same relay, when you reach it another way
  cpart relay remove <url>                                        stop using a relay. Contacts are told
  cpart relay move <url> [--as <url>] [--wait 60]                 make another relay your home: add it, tell contacts, and drop
                                                                  the old one once every contact has confirmed`;

// Print what happens to each relay connection, one line each.
export function logLink(link: RelayLink, connected: (up: boolean) => void, safe: (s: string) => string): void {
  link.on("relay", (url, up, why) => {
    connected(link.online);
    console.log(up ? `connected to ${safe(url)}` : `relay connection lost: ${safe(url)} (${safe(why)}), retrying`);
  });
  link.on("wake", (ms) => console.log(`woke after ${Math.round(ms / 1000)}s asleep, reconnecting`));
  link.on("network", () => console.log("network changed, checking connections"));
}

const healthUrl = (relay: string): string => {
  const u = new URL(relay);
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}${u.pathname.replace(/\/$/, "")}/healthz`;
};

async function answers(relay: string, ms = 5000): Promise<boolean> {
  return fetch(healthUrl(relay), { signal: AbortSignal.timeout(ms), redirect: "error" }).then((r) => r.ok, () => false);
}

const inContainer = (): boolean => existsSync("/.dockerenv") || existsSync("/run/.containerenv");

// The same relay by the name the other side of a container boundary uses.
// Inside a container, 127.0.0.1 is the container itself and the machine it runs
// on is host.docker.internal. Outside, it is the other way round.
export function otherName(relay: string): string | undefined {
  if (!isRelayUrl(relay)) return undefined;
  const u = new URL(relay);
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (inContainer() ? !loop : u.hostname !== "host.docker.internal") return undefined;
  u.hostname = inContainer() ? "host.docker.internal" : "127.0.0.1";
  return relayKey(u.href);
}

// Called before an identity is made from an invite or --relay. If the address
// does not answer here but its other name does, dial that and remember that
// others call it by the first. The caller has already checked the address.
export async function reachable(relay: string): Promise<{ relay: string; as?: string }> {
  const alt = otherName(relay);
  if (!alt || (await answers(relay, 2000)) || !(await answers(alt))) return { relay };
  return { relay: alt, as: relay };
}

// Lines for `cpart status`: contacts whose relays this identity does not use.
export function relayNotices(node: Counterpart, safe: (s: string) => string): string[] {
  const contacts = node.contacts().filter((c) => c.state === "active");
  return node.relayBook.missing(contacts).map((m) => {
    const c = contacts.find((x) => x.rootKey === m.rootKey)!;
    return `  ${c.name} can be reached on ${m.relays.map(safe).join(", ")}, and you use none of them\n      cpart relay add ${safe(m.relays[0]!)}`;
  });
}

interface Io {
  out(human: string, data: unknown): void;
  note(s: string): void;
  safe(s: string): string;
  ensureDaemon(): Promise<boolean>;
  flags: { as?: string; wait?: string; yes?: boolean };
}

export async function relayCommand(node: Counterpart, args: string[], io: Io): Promise<void> {
  const book = node.relayBook;
  const { safe } = io;
  const sub = args[0] ?? "list";
  const url = args[1];
  const as = io.flags.as ?? null;
  const active = () => node.contacts().filter((c) => c.state === "active");
  const need = async (what: string): Promise<string> => {
    if (!url || !isRelayUrl(url)) throw new Error(`usage: cpart relay ${what} <ws:// or wss:// address>`);
    if (as !== null && !isRelayUrl(as)) throw new Error("--as takes a ws:// or wss:// address");
    return url;
  };

  if (sub === "list") {
    const status = new Map(book.status().map((s) => [s.url, s]));
    const mine = book.mine();
    const pending = new Set(book.unconfirmed(active()));
    const lines = [
      "Your relays (contacts try them in this order):",
      ...mine.map((r) => {
        const s = status.get(r.url);
        const state = s ? (s.connected ? "connected" : `not connected${s.error ? `: ${safe(s.error)}` : ""}`) : "not seen by a daemon yet";
        return `  ${r.home ? "home   " : r.leaving ? "leaving" : "       "}  ${safe(r.url)}${r.as ? `  (others call it ${safe(r.as)})` : ""}  ${state}`;
      }),
      "",
      node.contacts().length ? "Contacts:" : "No contacts yet.",
      ...node.contacts().map((c) => {
        const t = book.their(c.rootKey, c.relay);
        const shared = book.route(t.relays).preferred.length > 0;
        const knows = !shared
          ? `\n${" ".repeat(19)}you use none of these, so your mail to them may not arrive: cpart relay add ${safe(t.relays[0]!)}`
          : book.version() === 0 || c.state !== "active" ? "" : t.seen < book.version() ? "  has NOT confirmed your current list" : "  has your current list";
        return `  ${c.name.padEnd(16)} reach them on ${t.relays.map(safe).join(", ")}${knows}`;
      }),
    ];
    return io.out(lines.join("\n"), {
      relays: mine.map((r) => ({ ...r, ...(status.get(r.url) ?? {}) })),
      version: book.version(),
      contacts: node.contacts().map((c) => ({ name: c.name, ...book.their(c.rootKey, c.relay), confirmed: !pending.has(c.rootKey) })),
    });
  }

  if (sub === "add") {
    const u = await need("add");
    if (!(await answers(u))) throw new Error(`no relay answers at ${safe(u)}. Nothing was changed.`);
    const changed = book.add(u, as, Date.now());
    const d = changed ? await io.ensureDaemon() : true;
    return io.out(
      changed ? `Added ${safe(u)}. Your daemon connects to it and tells your contacts.${d ? "" : " It is not running: start it with cpart up."}` : `${safe(u)} is already one of your relays.`,
      { added: changed, relays: book.mine() },
    );
  }

  if (sub === "remove") {
    const u = await need("remove");
    const r = book.remove(u, Date.now());
    const d = await io.ensureDaemon();
    return io.out(`Removed ${safe(r.url)}. Your daemon disconnects from it and tells your contacts.${d ? "" : " It is not running: start it with cpart up."}`, { removed: r.url, relays: book.mine() });
  }

  if (sub === "move") {
    const u = await need("move");
    const wait = Number(io.flags.wait ?? 60);
    if (!Number.isFinite(wait) || wait < 0 || wait > 86_400) throw new Error("--wait is a number of seconds");
    if (!book.find(u)?.home && !(await answers(u))) throw new Error(`no relay answers at ${safe(u)}. Nothing was changed.`);
    const { version } = book.moveHome(u, as, Date.now());
    const leaving = book.leaving();
    if (!leaving.length) return io.out(`${safe(book.home())} is already your home relay.`, { home: book.home(), done: true });
    io.note(`Home relay is now ${safe(book.home())}. Telling your contacts; ${leaving.map((r) => safe(r.url)).join(", ")} stays until they confirm.`);
    if (!(await io.ensureDaemon())) io.note("Your daemon is not running, so nobody can be told. Start it with cpart up, then run this again.");
    const end = Date.now() + wait * 1000;
    let left = book.unconfirmed(active());
    while (left.length && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 500));
      left = book.unconfirmed(active());
    }
    const gone = left.length ? null : book.finishMove(active, version, Date.now());
    if (!gone) {
      left = book.unconfirmed(active());
      const why = active()
        .filter((c) => left.includes(c.rootKey))
        .map((c) => {
          const t = book.their(c.rootKey, c.relay);
          return `  ${c.name}: ${t.seen < book.version() ? "has not confirmed your new list yet" : `does not use ${safe(book.home())} or another relay you keep. They need to run: cpart relay add ${safe(book.home())}`}`;
        });
      return io.out(
        `Not finished. ${why.length ? `Waiting for:\n${why.join("\n")}` : "Your relay list changed while waiting."}\nYour daemon keeps ${leaving.map((r) => safe(r.url)).join(", ")} meanwhile. Run the same command again later to finish, or drop the old relay now (anyone listed above may then not get your messages): cpart relay remove ${leaving.map((r) => safe(r.url)).join(" ")}`,
        { home: book.home(), done: false, unconfirmed: active().filter((c) => left.includes(c.rootKey)).map((c) => c.name) },
      );
    }
    return io.out(`Done. Every contact confirmed. ${gone.map(safe).join(", ")} removed; your daemon tells contacts that too.`, { home: book.home(), done: true, removed: gone });
  }

  throw new Error(`usage:\n${RELAY_USAGE}`);
}
