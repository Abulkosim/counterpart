#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type ContractView, Counterpart, RelayLink } from "@counterpart/daemon";
import { type ContractPart, canonicalize, verifyAgreement } from "@counterpart/protocol";
import { FrontDesk, addToBundle, anthropicApi, claudeCli, cliPrivateValues, readBundle, removeFromBundle } from "@counterpart/frontdesk";
import { startMcpServer } from "@counterpart/mcp";
import { startRelay } from "@counterpart/relay";
import { startViewer } from "@counterpart/viewer";
import { type WorkResult, apply as applyWork, work } from "@counterpart/worker";

const USAGE = `cpart: let your agent talk to someone else's agent

  cpart relay [--port 7447] [--host 127.0.0.1] [--db relay.db] [--url wss://public.name]   run a relay
  cpart init --relay <ws://host:port> [--no-passphrase]           create your identity
  cpart renew                                                     renew this device's credential (needs the passphrase)
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
  cpart mcp                                                       MCP server on stdio, for Claude Code and Codex
  cpart view [--port 7450]                                        read your threads in a browser, on this machine only

Contracts: the exact text two people agree to. Anyone on your side, including
your agent, can propose. Only you can approve, with your passphrase.

  cpart propose <thread> --title <t> --file <contract.md> [--part kind:file]... [--supersedes <id>]
  cpart contracts <thread>                                        proposals in a thread, with their ids
  cpart contract <thread> <id>                                    show the full text and attachments
  cpart approve <thread> <id>                                     sign it. This cannot be undone
  cpart decline <thread> <id> [reason]
  cpart withdraw <thread> <id>                                    stop asking for approval of your proposal
  cpart agreement export <thread> <id> [--out file]               the contract and both signatures
  cpart agreement verify <file>

Work: after an agreement, a model with no tools proposes the change to your
repo. It sees only committed files you name. Code checks every edit. Nothing
it writes is run, and nothing is written until you apply it.

  cpart work <thread> <id> --repo <path> --paths <a,b,dir> --brief <what to do> [--allow <sensitive path>]...
  cpart work show <work-id>                                       the patch, what was refused, what to look at first
  cpart work apply <work-id> <work-hash> [--repo <path>]          write the reviewed files. Commits nothing

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
    home: { type: "string" }, repo: { type: "string" }, paths: { type: "string" }, brief: { type: "string" }, allow: { type: "string", multiple: true }, title: { type: "string" }, file: { type: "string" }, part: { type: "string", multiple: true }, supersedes: { type: "string" },
    out: { type: "string" }, yes: { type: "boolean" }, "no-passphrase": { type: "boolean" }, as: { type: "string" }, slots: { type: "string" }, daily: { type: "string" }, model: { type: "string" }, url: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});
const [cmd, ...args] = positionals;
const home = flags.home ?? process.env.CPART_HOME ?? join(homedir(), ".counterpart");
const out = (human: string, data: unknown): void => console.log(flags.json ? JSON.stringify(data) : human);
const need = (n: number, usage: string): void => {
  if (args.length < n) throw new Error(`usage: cpart ${usage}`);
};
// Peer-controlled text goes to a terminal: escape control characters so it cannot move the cursor or fake output.
// That means C0 and C1 controls, and the invisible Unicode characters that reorder or hide text.
const HIDDEN = /[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff9-\ufffb]|\udb40[\udc00-\udc7f]/g;
const safe = (s: string): string =>
  JSON.stringify(s)
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(HIDDEN, (c) => [...c].map((x) => `\\u{${x.codePointAt(0)!.toString(16)}}`).join(""));
const time = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// Read a line from the terminal without showing it. CPART_PASSPHRASE is for
// scripts and tests; anything that can read your environment can read it.
async function secret(prompt: string): Promise<string> {
  if (process.env.CPART_PASSPHRASE !== undefined) return process.env.CPART_PASSPHRASE;
  if (!process.stdin.isTTY) throw new Error("this needs your passphrase. Run it in a terminal.");
  // Echo goes off before the prompt appears, so nothing typed early is shown.
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stderr.write(prompt);
  try {
    return await new Promise<string>((resolve, reject) => {
      let buf = "";
      const onData = (d: Buffer): void => {
        for (const ch of d.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            process.stdin.off("data", onData);
            process.stderr.write("\n");
            return resolve(buf);
          }
          if (ch === "\u0003") return reject(new Error("cancelled"));
          if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
          else if (ch >= " ") buf += ch;
        }
      };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

async function line(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("this needs a terminal");
  process.stderr.write(prompt);
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve) => process.stdin.once("data", (d: Buffer) => resolve(d.toString("utf8").trim())));
  } finally {
    process.stdin.pause();
  }
}

async function newPassphrase(): Promise<string> {
  if (process.env.CPART_PASSPHRASE !== undefined) return process.env.CPART_PASSPHRASE;
  const a = await secret("Choose a passphrase (8 characters or more). You will type it to approve contracts: ");
  if (a.length < 8) throw new Error("passphrase must be at least 8 characters");
  if ((await secret("Again: ")) !== a) throw new Error("the two passphrases differ");
  return a;
}

// Proposals are named by the id `cpart contracts` prints in its first column.
function findContract(node: Counterpart, threadId: string, prefix: string): ContractView {
  if (prefix.length < 6) throw new Error("give at least the first 6 characters of the proposal id");
  const hits = node.contracts(threadId).filter((c) => c.proposalId.startsWith(prefix));
  if (hits.length !== 1) throw new Error(hits.length ? `"${prefix}" matches ${hits.length} proposals; give more characters` : `no proposal starting "${prefix}" in this thread. See: cpart contracts <thread>`);
  return hits[0]!;
}

const block = (text: string): string => text.split("\n").map((l) => `    ${safe(l)}`).join("\n");

// Everything that will be signed is printed: the text and every attachment in full.
function describe(c: ContractView, contact: string): string {
  const signed = [c.approvedByMe ? "you" : null, c.approvedByThem ? contact : null].filter(Boolean).join(" and ") || "nobody yet";
  const parts = c.contract.parts.flatMap((p) => ["", `  Attached: ${p.name}  (${p.kind}, ${Buffer.byteLength(p.content)} bytes, sha256 ${createHash("sha256").update(p.content).digest("hex").slice(0, 16)})`, "", block(p.content)]);
  return [
    `Proposal  ${c.proposalId}`,
    `Contract  ${c.hash}  (hash of the text and attachments)`,
    `Status    ${c.status}${c.withdrawn && c.status !== "withdrawn" ? " (proposal withdrawn)" : ""}`,
    `Proposed  by ${c.proposedByMe ? "your side" : `${contact}'s side`} at ${time(c.proposedAt)}${c.supersedes ? `, replacing ${c.supersedes.slice(0, 12)}` : ""}`,
    `Approved  by ${signed}`,
    ...(c.declinedBy.length ? [`Declined  by ${c.declinedBy.map((d) => (d === "me" ? "you" : contact)).join(", ")}${c.declineReason ? `: ${safe(c.declineReason)}` : ""}`] : []),
    "",
    `  ${safe(c.contract.title)}`,
    "",
    block(c.contract.text),
    ...parts,
  ].join("\n");
}

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
    const passphrase = flags["no-passphrase"] ? undefined : await newPassphrase();
    const node = await Counterpart.init(home, { relay: flags.relay, ...(passphrase !== undefined ? { passphrase } : {}) });
    return out(`Created identity ${node.me.human} in ${home}${passphrase === undefined ? "\nNo passphrase: this identity can talk but cannot approve contracts. To sign agreements, create an identity with a passphrase." : ""}`, node.me);
  }
  if (cmd === "agreement" && args[0] === "verify") {
    if (!args[1]) throw new Error("usage: cpart agreement verify <file>");
    const a = verifyAgreement(JSON.parse(readFileSync(args[1], "utf8")));
    return out(
      [
        `Valid. Both parties signed contract ${a.contractHash}`,
        `In the thread opened ${time(a.genesis.createdAt)} with goal: ${safe((a.genesis.body as { goal: string }).goal)}`,
        ...a.approvals.map((x) => `  ${x.approver}  signed at ${time(x.approvedAt)} (their clock)`),
        "",
        `  ${safe(a.contract.title)}`,
        "",
        block(a.contract.text),
        "",
        ...a.contract.parts.flatMap((p) => ["", `  Attached: ${p.name} (${p.kind})`, "", block(p.content)]),
        "",
        "This proves these two keys approved this text. Check the keys belong to who you think: compare them with `cpart whoami` on each side.",
      ].join("\n"),
      a,
    );
  }

  const node = Counterpart.open(home);
  await node.renewIfDue();
  switch (cmd) {
    case "whoami": {
      const days = Math.floor((node.credentialExpiresAt - Date.now()) / 86_400_000);
      return out(
        `human  ${node.me.human}\nkey    ${node.me.rootKey}\ndevice ${node.me.device}\nrelay  ${node.me.relay}\nroot key ${node.protected ? "locked with a passphrase" : "not protected, so this identity cannot approve contracts"}\ndevice credential valid for ${days} more days${node.protected && days < 30 ? ". Run: cpart renew" : ""}`,
        { ...node.me, protected: node.protected, credentialExpiresAt: node.credentialExpiresAt },
      );
    }
    case "renew":
      await node.renew(node.protected ? await secret("Passphrase: ") : undefined);
      return out("Device credential renewed. Contacts will be told.", { credentialExpiresAt: node.credentialExpiresAt });
    case "propose": {
      need(1, "propose <thread> --title <t> --file <contract.md>");
      if (!flags.title || !flags.file) throw new Error("usage: cpart propose <thread> --title <t> --file <contract.md> [--part kind:file]...");
      const parts = (flags.part ?? []).map((spec): ContractPart => {
        const i = spec.indexOf(":");
        const kind = spec.slice(0, i);
        if (i < 0 || !["text", "json-schema", "openapi"].includes(kind)) throw new Error(`--part ${spec}: use text:file, json-schema:file or openapi:file`);
        const path = spec.slice(i + 1);
        return { kind: kind as ContractPart["kind"], name: path.split("/").pop()!, content: readFileSync(path, "utf8") };
      });
      const supersedes = flags.supersedes ? findContract(node, args[0]!, flags.supersedes).proposalId : undefined;
      const r = await node.propose(args[0]!, { title: flags.title, text: readFileSync(flags.file, "utf8"), parts }, supersedes ? { supersedes } : {});
      return out(`Proposed ${r.proposalId}\nContract hash ${r.hash}`, { proposalId: r.proposalId, hash: r.hash });
    }
    case "contracts": {
      need(1, "contracts <thread>");
      const list = node.contracts(args[0]!);
      return out(
        list.length ? list.map((c) => `${c.proposalId.slice(0, 12)}  ${c.status.padEnd(10)} ${c.proposedByMe ? "mine  " : "theirs"}  signed: ${c.approvedByMe ? "me" : "--"} ${c.approvedByThem ? "them" : "----"}  ${safe(c.contract.title)}`).join("\n") : "No contracts in this thread.",
        list,
      );
    }
    case "contract": {
      need(2, "contract <thread> <hash>");
      const t = node.threads().find((x) => x.id === args[0]);
      const c = findContract(node, args[0]!, args[1]!);
      return out(describe(c, t?.contact ?? "them"), c);
    }
    case "approve": {
      need(2, "approve <thread> <hash>");
      const t = node.threads().find((x) => x.id === args[0]);
      if (!t) throw new Error(`no thread ${args[0]}`);
      const c = findContract(node, t.id, args[1]!);
      if (c.approvedByMe) throw new Error("you have already approved this proposal");
      const peer = node.contact(t.contact);
      console.error(describe(c, t.contact));
      console.error(
        [
          "",
          `Between you (${node.me.rootKey.slice(0, 12)}) and ${t.contact} (${peer.rootKey.slice(0, 12)}, safety code ${peer.safetyCode}).`,
          c.proposedByMe ? "Your side proposed this text. Read it anyway: your agent may have written it." : `This text was written by ${t.contact}'s side. Read all of it.`,
          ...(c.status === "superseded" ? ["A newer proposal replaces this one. You are approving the OLD text."] : []),
          ...(c.withdrawn ? ["This proposal was withdrawn. Your approval would still count if the other side also signs."] : []),
          "",
          "Approving signs this exact text and every attachment above with your key. It cannot be undone or withdrawn.",
          "It records that you agree. It does not let anyone run anything on your machine.",
          "",
        ].join("\n"),
      );
      if (!flags.yes) {
        const typed = await line("Type the first 6 characters of the contract hash shown above to continue: ");
        if (typed !== c.hash.slice(0, 6)) throw new Error("that does not match. Nothing was signed.");
      } else if (process.env.CPART_PASSPHRASE === undefined) throw new Error("--yes is only for scripts that set CPART_PASSPHRASE");
      // The proposal id and hash are the ones just displayed; if either has changed underneath, the node refuses.
      await node.approve(t.id, c.proposalId, c.hash, await secret("Passphrase: "));
      return out(`Approved proposal ${c.proposalId}\nContract hash ${c.hash}`, { proposalId: c.proposalId, hash: c.hash });
    }
    case "decline": {
      need(2, "decline <thread> <hash> [reason]");
      const c = findContract(node, args[0]!, args[1]!);
      await node.decline(args[0]!, c.proposalId, args.slice(2).join(" ") || undefined);
      return out(`Declined ${c.proposalId}`, { proposalId: c.proposalId });
    }
    case "withdraw": {
      need(2, "withdraw <thread> <hash>");
      const c = findContract(node, args[0]!, args[1]!);
      await node.withdraw(args[0]!, c.proposalId);
      return out(`Withdrew ${c.proposalId}. Approvals already given still stand.`, { proposalId: c.proposalId });
    }
    case "work": {
      const dir = join(home, "work");
      const load = (id: string): WorkResult & { id: string; repo: string } => {
        if (!/^[A-Za-z0-9_-]{6,40}$/.test(id) || !existsSync(join(dir, `${id}.json`))) throw new Error(`no work "${id}"`);
        return JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as WorkResult & { id: string; repo: string };
      };
      const summary = (w: WorkResult & { id: string; repo: string }): string =>
        [
          `Work      ${w.id}`,
          `Repo      ${safe(w.repo)} at ${w.baseCommit.slice(0, 12)}`,
          `Work hash ${w.workHash}  (covers the base commit and every byte to be written)`,
          `Shown     ${w.given.length} file(s): ${w.given.map(safe).join(", ")}`,
          `Changes   ${w.changes.length ? w.changes.map((c) => `${safe(c.path)} (${c.status})`).join(", ") : "none"}`,
          ...(w.refused.length ? ["", "Refused by the checker:", ...w.refused.map((r) => `  ${safe(r.path)}: ${safe(r.reason)}`)] : []),
          ...(w.flags.length ? ["", "Look at these first:", ...w.flags.map((f) => `  ${safe(f)}`)] : []),
          ...(w.notes ? ["", "The model's own account (it may be wrong, and the agreement text may have steered it):", block(w.notes)] : []),
        ].join("\n");
      if (args[0] === "show") {
        need(2, "work show <work-id>");
        const w = load(args[1]!);
        return out(`${summary(w)}\n\n${w.patch.split("\n").map(safe).join("\n")}\nTo write these files: cpart work apply ${w.id} ${w.workHash.slice(0, 12)}`, w);
      }
      if (args[0] === "apply") {
        need(3, "work apply <work-id> <work-hash>");
        const w = load(args[1]!);
        if (args[2]!.length < 12 || !w.workHash.startsWith(args[2]!)) throw new Error("give at least the first 12 characters of the work hash that `cpart work show` printed");
        applyWork(flags.repo ?? w.repo, w, w.workHash);
        return out(`Wrote ${w.files.length} file(s) in ${flags.repo ?? w.repo}. Nothing is committed. Run your tests, then commit.`, { files: w.files.map((f) => f.path) });
      }
      need(2, "work <thread> <id> --repo <path> --paths <a,b> --brief <text>");
      if (!flags.repo || !flags.paths || !flags.brief) throw new Error("usage: cpart work <thread> <id> --repo <path> --paths <a,b,dir> --brief <what to do>");
      const t = node.threads().find((x) => x.id === args[0]);
      if (!t) throw new Error(`no thread ${args[0]}`);
      const c = findContract(node, t.id, args[1]!);
      if (c.status !== "agreed") throw new Error("work starts from an agreement. Both people must approve this proposal first.");
      const key = process.env.ANTHROPIC_API_KEY;
      const pick = flags.model ? { model: flags.model } : {};
      const result = await work(
        { repo: flags.repo, paths: flags.paths.split(",").map((p) => p.trim()).filter(Boolean), brief: flags.brief, contract: c.contract, contact: t.contact, ...(flags.allow ? { allow: flags.allow } : {}) },
        key ? anthropicApi({ apiKey: key, maxTokens: 16000, ...pick }) : claudeCli({ timeoutMs: 600_000, ...pick }),
      );
      const id = result.workHash.slice(0, 10);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const saved = { id, repo: flags.repo, ...result };
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(saved), { mode: 0o600 });
      return out(`${summary(saved)}\n\nRead the patch before anything else: cpart work show ${id}`, saved);
    }
    case "agreement": {
      if (args[0] !== "export") throw new Error("usage: cpart agreement export <thread> <hash> [--out file] | cpart agreement verify <file>");
      need(3, "agreement export <thread> <hash>");
      const c = findContract(node, args[1]!, args[2]!);
      const a = node.agreement(args[1]!, c.proposalId);
      // Keys in canonical order, so both sides write byte-identical files.
      const json = JSON.stringify(JSON.parse(canonicalize(a)), null, 2);
      if (flags.out) writeFileSync(flags.out, `${json}\n`);
      return flags.out ? out(`Wrote ${flags.out}`, { file: flags.out }) : console.log(json);
    }
    case "daemon": {
      const link = new RelayLink(node).start();
      link.on("ready", () => console.log(`connected to ${node.relay}`));
      link.on("offline", () => console.log("relay connection lost, retrying"));
      link.on("error", (e) => console.error(`error: ${safe(e.message)}`));
      link.on("verdict", (v) => {
        if (v.result === "rejected") console.log(`refused a message: ${safe(v.reason)}`);
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
        const b = e.body as Record<string, unknown>;
        const what =
          e.type === "talk.posted" ? (b.text as string)
          : e.type === "thread.opened" ? `opened: ${b.goal as string}`
          : e.type === "contract.proposed" ? `proposed a contract: ${(b.contract as { title: string }).title}`
          : e.type === "contract.accepted" ? `APPROVED proposal ${(b.approval as { proposalId: string }).proposalId.slice(0, 12)}`
          : e.type === "contract.declined" ? `declined proposal ${(b.proposalId as string).slice(0, 12)}`
          : e.type === "contract.withdrawn" ? `withdrew proposal ${(b.proposalId as string).slice(0, 12)}`
          : e.type;
        // One event, one line, stamped with the time it took effect here. The
        // sender's own clock and line breaks are theirs to fake.
        return `${time(e.receivedAt)}  ${who.padEnd(12)} ${e.status === "pending" ? "(held) " : ""}${safe(what)}`;
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
    case "mcp":
      await startMcpServer(node);
      return;
    case "view": {
      const viewer = await startViewer(node, flags.port ? { port: Number(flags.port) } : {});
      console.log(`Open ${viewer.url}\nThe link carries a key. Anyone who has it and can reach this machine's loopback address can read your threads.`);
      const stop = () => void viewer.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "rejects": {
      const list = node.rejects();
      return out(list.length ? list.map((r) => `${time(r.at)}  ${safe(r.reason)}`).join("\n") : "Nothing has been refused.", list);
    }
    default:
      throw new Error(`unknown command "${cmd}". Run: cpart help`);
  }
}

main().catch((e: Error) => {
  console.error(`cpart: ${e.message}`);
  process.exit(1);
});
