// `cpart invite` and `cpart join` with a short code. The daemon does the work
// (packages/daemon/src/pairing.ts); these functions ask it and wait.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Counterpart, type PairingView, OLD_RELAY, PairingStore, checkName } from "@counterpart/daemon";
import { codeWithRelay, parseCode } from "@counterpart/protocol";

export interface Io {
  out(human: string, data: unknown): void;
  note(s: string): void;
  safe(s: string): string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

async function watch(store: PairingStore, id: string, ms: number, stop: (v: PairingView) => boolean, onChange: (v: PairingView) => void = () => {}): Promise<PairingView> {
  const end = Date.now() + ms;
  let last = "";
  for (;;) {
    const v = store.get(id)!;
    const sig = `${v.state}/${v.claimed}`;
    if (sig !== last) {
      last = sig;
      onChange(v);
    }
    if (stop(v) || Date.now() > end) return v;
    await sleep(200);
  }
}

const NEXT = (name: string): string => `Now, in Claude Code or Codex, say something like:\n  ask ${name}'s agent what their API returns for an empty page`;

// Prints a code and, unless told not to, waits for the pairing to end.
// Returns false when no code could be made; the caller then offers the long invite.
export async function inviteByCode(node: Counterpart, name: string, io: Io, opts: { daemon: boolean; wait: boolean }): Promise<boolean> {
  checkName(name);
  if (node.contacts().some((c) => c.name === name)) throw new Error(`contact "${name}" already exists`);
  if (!opts.daemon) return false;
  const store = new PairingStore(node.home);
  try {
    const id = store.requestInvite(name, node.relayName);
    const got = await watch(store, id, 15_000, (v) => v.state !== "requested");
    if (got.state === "requested" || (got.state === "failed" && got.detail?.startsWith(OLD_RELAY))) return false;
    if (got.state === "failed" || !got.code) throw new Error(got.detail ?? "no code was made");
    const full = codeWithRelay(got.nameplate!, got.code.split("-").slice(1), node.relayName);
    const line = `cpart join ${full} <your name>`;
    io.out(
      [
        `Code for ${name}: ${got.code}`,
        `It works once, until ${clock(got.expiresAt)}. Send ${name} this line; they run it with the name they call you:`,
        "",
        `  ${line}`,
        "",
        `Reading it aloud? The number and words are what matter. If ${name} already uses ${io.safe(node.relayName)}, the code alone is enough.`,
      ].join("\n"),
      { id, code: got.code, full, line, nameplate: got.nameplate, relay: node.relayName, expiresAt: got.expiresAt },
    );
    if (!opts.wait) return true;
    io.note(`\nWaiting for ${name}. Ctrl-C stops waiting; your daemon still finishes the pairing, and cpart status shows how it went.`);
    const end = await watch(store, id, got.expiresAt - Date.now() + 90_000, (v) => v.state === "done" || v.state === "failed", (v) => {
      if (v.state === "open" && v.claimed) io.note("Someone has entered the code. Checking it.");
      if (v.state === "confirmed") io.note(`${name} proved the code. Waiting for their contact request.`);
    });
    if (end.state === "done") io.note(`\nPaired with ${name}. The code proved who is on each side, so there is no safety code to compare.\n\n${NEXT(name)}`);
    else if (end.state === "failed") throw new Error(`${end.detail ?? "the pairing failed"}\nMake a new code: cpart invite ${name}`);
    else io.note("\nStill waiting. Your daemon finishes it in the background; cpart status shows how it went.");
    return true;
  } finally {
    store.close();
  }
}

// `cpart join <code> <name>`. `setup` makes the identity and starts the daemon
// when there is none yet, which needs the relay the code names.
export async function joinByCode(home: string, input: string, name: string, io: Io, setup: (relay: string | undefined) => Promise<Counterpart>): Promise<void> {
  const code = parseCode(input);
  // Before anything is made or sent: a bad name found later would waste the code.
  checkName(name);
  if (!code.relay && !existsSync(join(home, "keys.json"))) {
    throw new Error("this code does not say which relay to use, and you have no identity yet. Ask for the whole line, the one with @ in it.");
  }
  const node = await setup(code.relay);
  if (node.contacts().some((c) => c.name === name)) throw new Error(`you already have a contact named ${name}. Pick another name.`);
  const store = new PairingStore(home);
  try {
    const id = store.requestJoin(code, name, node.relayName);
    io.note(`\nChecking the code with ${io.safe(node.relayName)}`);
    const end = await watch(store, id, 120_000, (v) => v.state === "done" || v.state === "failed");
    const c = node.contacts().find((x) => x.name === name);
    if (end.state === "done" && c) {
      io.out(`\nPaired with ${name}. The code proved who is on each side, so there is no safety code to compare.\n\n${NEXT(name)}`, c);
    } else if (end.state === "failed") {
      throw new Error(end.detail?.startsWith(OLD_RELAY) ? end.detail : `${end.detail ?? "the pairing failed"} To try again, ask ${name} for a new code.`);
    } else if (end.state === "confirmed") {
      io.note(`\nBoth sides proved the code. Your contact request is on its way to ${name}; it completes when their daemon answers. Check with: cpart status`);
    } else {
      io.note(`\nNo answer yet from the other side. Your daemon keeps waiting until ${clock(end.expiresAt)}. Check with: cpart status`);
    }
  } finally {
    store.close();
  }
}

// Lines for `cpart status`: codes waiting, pairings that ended in the last
// hour. A pairing that worked is news, not something to do.
export function pairingLines(home: string): { waiting: string[]; news: string[] } {
  if (!existsSync(join(home, "pairing.db"))) return { waiting: [], news: [] };
  const store = new PairingStore(home);
  try {
    const all = store.recent();
    const news = all.filter((v) => v.state === "done").map((v) => `  paired with ${v.name} ${v.detail ? `(${v.detail})` : "by code"} at ${clock(v.updatedAt)}`);
    const waiting = all.filter((v) => v.state !== "done").map((v) => {
      const who = v.role === "inviter" ? `for ${v.name}` : `with ${v.name}`;
      if (v.state === "failed") return `  pairing ${who} failed at ${clock(v.updatedAt)}: ${v.detail ?? ""}`;
      if (v.state === "open") return `  code ${v.code} ${who} works until ${clock(v.expiresAt)}${v.claimed ? "; someone has entered it" : ""}`;
      if (v.state === "confirmed") return `  pairing ${who}: both sides proved the code; waiting for the contact request`;
      return `  pairing ${who}: in progress`;
    });
    return { waiting, news };
  } finally {
    store.close();
  }
}
