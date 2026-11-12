#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Counterpart, RelayLink } from "@counterpart/daemon";
import { FrontDesk, addToBundle, anthropicApi, claudeCli, cliPrivateValues, readBundle, removeFromBundle } from "@counterpart/frontdesk";
import { startRelay } from "@counterpart/relay";

const USAGE = `cpart: let your agent talk to someone else's agent

  cpart relay [--port 7447] [--host 127.0.0.1] [--db relay.db] [--url wss://public.name]   run a relay
  cpart init --relay <ws://host:port>                             create your identity
  cpart whoami
  cpart daemon                                                    stay connected, deliver and receive
  cpart invite <name>                                             make an invite; <name> is what you call them
  cpart accept <invite> <name>                                    accept someone's invite
  cpart contacts
  cpart open <contact> <goal>                                     start a thread
  cpart say <thread> <text>
  cpart threads
  cpart log <thread>
  cpart rejects                                                   messages that were refused, and why

Front desk: a model with no tools that answers a contact while you are away,
using only the files you put in that contact's bundle.

  cpart bundle add <contact> <file...>                            share copies of these files with a contact
  cpart bundle list <contact>
  cpart bundle remove <contact> <name>
  cpart desk on <contact> [--as <your name>] [--slots 6] [--daily 30]
  cpart desk off <contact>
  cpart desk status
  cpart desk refill <thread>                                      allow more replies in a thread
  cpart asks                                                      questions the front desk passed to you

Identity lives in $CPART_HOME (default ~/.counterpart). Add --json for machine output.`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    relay: { type: "string" }, port: { type: "string" }, host: { type: "string" }, db: { type: "string" },
    home: { type: "string" }, as: { type: "string" }, slots: { type: "string" }, daily: { type: "string" }, model: { type: "string" }, url: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});
const [cmd, ...args] = positionals;
const home = flags.home ?? process.env.CPART_HOME ?? join(homedir(), ".counterpart");
const out = (human: string, data: unknown): void => console.log(flags.json ? JSON.stringify(data) : human);
const need = (n: number, usage: string): void => {
  if (args.length < n) throw new Error(`usage: cpart ${usage}`);
};
// Peer-controlled text goes to a terminal: escape control characters so it cannot move the cursor or fake output.
const safe = (s: string): string => JSON.stringify(s).slice(1, -1);
const time = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

async function main(): Promise<void> {
  if (!cmd || flags.help || cmd === "help") return console.log(USAGE);

  if (cmd === "relay") {
    const relay = await startRelay({ port: Number(flags.port ?? 7447), host: flags.host ?? "127.0.0.1", dbPath: flags.db ?? "relay.db", ...(flags.url ? { publicUrl: flags.url } : {}), log: (l) => console.log(l) });
    process.on("SIGINT", () => void relay.close().then(() => process.exit(0)));
    process.on("SIGTERM", () => void relay.close().then(() => process.exit(0)));
    return;
  }
  if (cmd === "init") {
    if (!flags.relay) throw new Error("usage: cpart init --relay <ws://host:port>");
    const node = await Counterpart.init(home, { relay: flags.relay });
    return out(`Created identity ${node.me.human} in ${home}`, node.me);
  }

  const node = Counterpart.open(home);
  await node.renewIfDue();
  switch (cmd) {
    case "whoami":
      return out(`human  ${node.me.human}\ndevice ${node.me.device}\nrelay  ${node.me.relay}`, node.me);
    case "daemon": {
      const link = new RelayLink(node).start();
      link.on("ready", () => console.log(`connected to ${node.relay}`));
      link.on("offline", () => console.log("relay connection lost, retrying"));
      link.on("error", (e) => console.error(`error: ${e.message}`));
      link.on("verdict", (v) => {
        if (v.result === "rejected") console.log(`refused a message: ${v.reason}`);
      });
      link.on("event", (e) => console.log(`${e.type} in thread ${e.threadId}`));
      // With an API key the model sees exactly what we send. Without one, the
      // claude CLI is used with a subscription login; it adds a few values of its
      // own, which are filtered out of replies.
      const key = process.env.ANTHROPIC_API_KEY;
      const pick = flags.model ? { model: flags.model } : {};
      const desk = key ? new FrontDesk(node, anthropicApi({ apiKey: key, ...pick })) : new FrontDesk(node, claudeCli(pick), { forbidden: cliPrivateValues() });
      desk.onError = (e) => console.error(`front desk: ${e.message}`);
      desk.start();
      const stop = () => void Promise.all([link.stop(), desk.stop()]).then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "invite": {
      need(1, "invite <name>");
      const invite = node.createInvite(args[0]!);
      return out(`Send this to ${args[0]}. It works once and expires in 24 hours.\n\n${invite}`, { invite });
    }
    case "accept": {
      need(2, "accept <invite> <name>");
      const c = await node.acceptInvite(args[0]!, args[1]!);
      return out(`Request queued for ${c.name}. Compare this safety code with them: ${c.safetyCode}`, c);
    }
    case "contacts": {
      const list = node.contacts();
      return out(list.length ? list.map((c) => `${c.name.padEnd(20)} ${c.state.padEnd(8)} safety code ${c.safetyCode}`).join("\n") : "No contacts yet. Run: cpart invite <name>", list);
    }
    case "open": {
      need(2, "open <contact> <goal>");
      const id = await node.openThread(args[0]!, args.slice(1).join(" "));
      return out(`Opened thread ${id}`, { threadId: id });
    }
    case "say": {
      need(2, "say <thread> <text>");
      const e = await node.say(args[0]!, args.slice(1).join(" "));
      return out(`Queued ${e.id}`, e);
    }
    case "threads": {
      const list = node.threads();
      return out(list.length ? list.map((t) => `${t.id}  ${t.contact.padEnd(16)} ${String(t.events).padStart(3)} events  ${time(t.lastAt)}  ${safe(t.goal)}`).join("\n") : "No threads yet.", list);
    }
    case "log": {
      need(1, "log <thread>");
      const t = node.threads().find((x) => x.id === args[0]);
      if (!t) throw new Error(`no thread ${args[0]}`);
      const events = node.log(t.id);
      const lines = events.map((e) => {
        const via = (e.body as { via?: string }).via;
        const who = e.mine ? (via === "frontdesk" ? "my desk" : "me") : t.contact;
        const what = e.type === "talk.posted" ? (e.body as { text: string }).text : e.type === "thread.opened" ? `opened: ${(e.body as { goal: string }).goal}` : e.type;
        const text = what.split("\n").map(safe).join(`\n${" ".repeat(34)}`);
        return `${time(e.createdAt)}  ${who.padEnd(12)} ${e.status === "pending" ? "(held) " : ""}${text}`;
      });
      return out(lines.join("\n"), events);
    }
    case "bundle": {
      need(2, "bundle add|list|remove <contact> ...");
      const c = node.contact(args[1]!);
      const b = args[0] === "add" ? addToBundle(home, c.name, args.slice(2)) : args[0] === "remove" ? removeFromBundle(home, c.name, args[2] ?? "") : readBundle(home, c.name);
      if (args[0] === "add" && args.length < 3) throw new Error("usage: cpart bundle add <contact> <file...>");
      const list = b.files.map((f) => `${f.name.padEnd(32)} ${String(Buffer.byteLength(f.text)).padStart(7)} bytes`).join("\n");
      return out(b.files.length ? `${c.name} can be told what is in:\n${list}` : `Nothing is shared with ${c.name}.`, { contact: c.name, hash: b.hash, files: b.files.map((f) => ({ name: f.name, sha256: f.sha256 })) });
    }
    case "desk": {
      const desk = new FrontDesk(node, async () => {
        throw new Error("not available here");
      });
      const show = (d: { contact: string; enabled: boolean; owner: string; slotsPerThread: number; slotsPerDay: number }): string =>
        `${d.contact.padEnd(20)} ${d.enabled ? "on " : "off"}  answers as ${d.owner}'s front desk, ${d.slotsPerThread} replies per thread, ${d.slotsPerDay} per day, ${readBundle(home, d.contact).files.length} file(s) shared`;
      if (args[0] === "status" || !args[0]) {
        const list = desk.desks();
        return out(list.length ? list.map(show).join("\n") : "No contacts yet.", list);
      }
      if (args[0] === "refill") {
        need(2, "desk refill <thread>");
        desk.refill(args[1]!);
        return out(`Thread ${args[1]} can get replies again.`, { ok: true });
      }
      if (args[0] !== "on" && args[0] !== "off") throw new Error("usage: cpart desk on|off|status|refill");
      need(2, `desk ${args[0]} <contact>`);
      const d = desk.configure(args[1]!, {
        enabled: args[0] === "on",
        ...(flags.as ? { owner: flags.as } : {}),
        ...(flags.slots ? { slotsPerThread: Number(flags.slots) } : {}),
        ...(flags.daily ? { slotsPerDay: Number(flags.daily) } : {}),
      });
      return out(show(d), d);
    }
    case "asks": {
      const desk = new FrontDesk(node, async () => "");
      const list = desk.asks();
      return out(list.length ? list.map((a) => `${time(a.at)}  ${a.contact.padEnd(12)} thread ${a.threadId}  ${safe(a.question)}`).join("\n") : "The front desk has not passed you any questions.", list);
    }
    case "rejects": {
      const list = node.rejects();
      return out(list.length ? list.map((r) => `${time(r.at)}  ${r.reason}`).join("\n") : "Nothing has been refused.", list);
    }
    default:
      throw new Error(`unknown command "${cmd}". Run: cpart help`);
  }
}

main().catch((e: Error) => {
  console.error(`cpart: ${e.message}`);
  process.exit(1);
});
