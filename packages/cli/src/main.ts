#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type ContractView, type EvidenceView, Counterpart, RelayLink } from "@counterpart/daemon";
import { type ContractPart, type Evidence, canonicalize, decodeInvite, isHttpsUrl, verifyAgreement } from "@counterpart/protocol";
import { FrontDesk, addToBundle, anthropicApi, claudeCli, cliPrivateValues, readBundle, removeFromBundle } from "@counterpart/frontdesk";
import { hookMain, startMcpServer } from "@counterpart/mcp";
import { type Binding, collectEvidence, preparePublication, publish, repoInit } from "@counterpart/publish";
import { splitUrls, startRelay } from "@counterpart/relay";
import { startViewer } from "@counterpart/viewer";
import { type WorkResult, apply as applyWork, work } from "@counterpart/worker";
import { agents, bootInstalled, claim, down, logFile, registerAgents, running, up } from "./service.ts";
import { openTunnel } from "./tunnel.ts";
import { GUARD_USAGE, guardCommand } from "./guard-cli.ts";
import { SHARE_USAGE, shareCommand, sharedSummary } from "./share.ts";
import { hookLines, installHooks, removeHooks } from "./hooks-install.ts";
import { inviteByCode, joinByCode, pairingLines } from "./pair.ts";
import { PairingEngine } from "@counterpart/daemon";
import { looksLikeCode } from "@counterpart/protocol";
import { RELAY_SUBCOMMANDS, RELAY_USAGE, logLink, reachable, relayCommand, relayNotices } from "./relays.ts";

const USAGE = `cpart: let your agent talk to someone else's agent

Start here. One of these is all the setup there is:

  cpart setup --relay <wss://host> [--no-hooks]                   create your identity, keep the daemon running, add Counterpart to
                                                                  Claude Code and Codex. Safe to run again. --no-hooks leaves out
                                                                  the hooks that tell a session when a reply arrives
  cpart join <code> <name>                                        the same, with the code someone sent you (7-cider-otter@host).
                                                                  <name> is what you call them. A long cpart-invite: works too
  cpart invite <name> [--no-wait] [--long]                        make a short code to send, then wait for them. <name> is what you
                                                                  call them. --long makes the long invite instead. With --json
                                                                  the long invite is printed unless you add --code
  cpart status                                                    is everything running, and what is waiting for you
  cpart up [--boot] | cpart down                                  start or stop the background daemon. --boot also starts it at login

Wherever a command takes <thread>, a contact's name means your latest thread
with them, and the first characters of a thread id are enough.

The pieces, if you want to run them yourself:

  cpart relay [--port 7447] [--host 127.0.0.1] [--db relay.db] [--url wss://public.name]... [--tunnel]
                                                                  run a relay. --url once for each address it answers to.
                                                                  --tunnel gives it a public address through
                                                                  cloudflared, for trying it with someone; the address changes on restart
${RELAY_USAGE}
  cpart init --relay <ws://host:port> [--no-passphrase]           create your identity
  cpart renew                                                     renew this device's credential (needs the passphrase)
  cpart whoami
  cpart daemon                                                    stay connected, deliver and receive, in this terminal
  cpart accept <invite> <name>                                    accept someone's invite
  cpart contacts
  cpart open <contact> <goal>                                     start a thread
  cpart say <thread> <text>
  cpart threads
  cpart log <thread>                                              your own lines show (queued) or (at relay) until their daemon confirms
  cpart rejects                                                   messages that were refused, and why
  cpart mcp [--notify] [--view-port 7450]                         MCP server on stdio, for Claude Code and Codex. --notify tells a
                                                                  live Claude Code session when something arrives, never what
  cpart view [--port 7450]                                        read your threads in a browser, on this machine only
  cpart hook install | remove                                     add or take out the Claude Code and Codex hooks. setup adds them
  cpart hook prompt|tool|stop|watch                               what those hooks run. Reads Claude Code's hook JSON on stdin

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

Publish: tie a repository to an agreement and open the pull request.

  cpart repo init <thread> <id> --repo <path> --bind <part>=<path>[,<valid fixtures dir>,<invalid fixtures dir>]...
                                                                  writes the trust file, the verifier and its workflow. Commit them to your main branch
  cpart pr <thread> <id> --work <work-id> [--repo <path>] [--branch <name>] [--evidence [--label <owner/name>]]
                                                                  commits the applied work and the agreement on a branch, pushes, opens a pull request.
                                                                  --evidence then tells the other side what was published

Evidence: tell the other side what your repository holds for an agreed proposal.
The values are read from committed Git objects by code. What the other side
sends you is their claim; only what your machine could recompute is marked checked.

  cpart evidence send <thread> <id> --repo <path> [--head <ref>] [--base <ref>] [--label <owner/name>] [--pr <https url>] [--run <https url> --status success|failure]
  cpart evidence <thread> [id]                                    evidence from both sides: what was checked here, and what is only claimed

Front desk: a model with no tools that answers a contact while you are away,
using only the files you shared with that contact: committed files from your
repository, or copies you put in their bundle.

${SHARE_USAGE}
  cpart bundle add <contact> <file...>                            share copies of these files with a contact
  cpart bundle list <contact>
  cpart bundle remove <contact> <name>
  cpart desk on <contact> [--as <your name>] [--slots 6] [--daily 30]
  cpart desk off <contact>
  cpart desk status
  cpart desk refill <thread>                                      allow more replies in a thread
  cpart asks [--all]                                              questions the front desk passed to you that are still open
  cpart asks answer <id> [text]                                   mark one answered. With text, send it to the contact as your own message
  cpart asks dismiss <id>                                         close one without answering

${GUARD_USAGE}

Identity lives in $CPART_HOME (default ~/.counterpart). Add --json for machine output.`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    relay: { type: "string" }, port: { type: "string" }, host: { type: "string" }, db: { type: "string" },
    home: { type: "string" }, evidence: { type: "boolean" }, head: { type: "string" }, base: { type: "string" }, label: { type: "string" }, pr: { type: "string" }, run: { type: "string" }, status: { type: "string" }, bind: { type: "string", multiple: true }, work: { type: "string" }, branch: { type: "string" }, repo: { type: "string" }, paths: { type: "string" }, brief: { type: "string" }, allow: { type: "string", multiple: true }, title: { type: "string" }, file: { type: "string" }, part: { type: "string", multiple: true }, supersedes: { type: "string" },
    out: { type: "string" }, yes: { type: "boolean" }, all: { type: "boolean" }, notify: { type: "boolean" }, "view-port": { type: "string" }, "no-passphrase": { type: "boolean" }, as: { type: "string" }, slots: { type: "string" }, daily: { type: "string" }, model: { type: "string" }, url: { type: "string", multiple: true }, wait: { type: "string" }, boot: { type: "boolean" }, "no-boot": { type: "boolean" }, "no-agents": { type: "boolean" }, "no-hooks": { type: "boolean" }, tunnel: { type: "boolean" }, "no-wait": { type: "boolean" }, long: { type: "boolean" }, code: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
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

const digest = (hex: string | null): string => (hex === null ? "no file" : `sha256 ${hex.slice(0, 16)}`);
const CHANGED = { head: "head", base: "base", bindings: "bindings", policy: "trust policy" } as const;

// One piece of evidence. Lines under "Checked here" come from comparing with
// what this machine holds. Everything under "claim" is the sender's word.
function describeEvidence(v: EvidenceView, contact: string): string {
  const k = v.claim;
  const whose = v.mine ? "your" : `${contact}'s`;
  const mark = (ok: boolean): string => (ok ? "ok      " : "MISMATCH");
  const partLine = (p: EvidenceView["checked"]["parts"][number]): string => {
    const at = `${p.part} at ${safe(p.path)}`;
    if (p.check === "match") return `    ${mark(true)}  ${at}: the digest sent is the signed part's (${digest(p.sha256)})`;
    if (p.check === "mismatch") return `    ${mark(false)}  ${at}: the digest sent (${digest(p.sha256)}) is not the signed part's (${digest(p.signedSha256)})`;
    if (p.check === "missing") return `    ${mark(false)}  ${at}: the sender reports no file there`;
    return `    ${mark(false)}  ${at}: the signed contract has no part with this name`;
  };
  return [
    `Evidence ${v.eventId.slice(0, 12)} from ${whose} side, ${v.mine ? "sent" : "arrived"} ${time(v.at)}: ${v.state === "current" ? "current" : v.state === "stale" ? `STALE (${v.changed.map((c) => CHANGED[c]).join(", ")} changed since)` : "replaced by a newer report for the same commits"}`,
    "  Checked here against what you hold:",
    `    ${mark(v.checked.agreed)}  ${v.checked.agreed ? "names a proposal and contract hash both of you signed in this thread" : "does not name an agreed proposal of this thread"}`,
    ...v.checked.parts.map(partLine),
    ...v.checked.unreported.map((n) => `    --------  ${n}: signed, but this evidence says nothing about it`),
    `    ${v.checked.verifier === "same" ? "ok      " : "DIFFERS "}  verifier ${safe(k.verifier.version)} (sha256 ${k.verifier.sha256.slice(0, 16)}) ${v.checked.verifier === "same" ? "is the one this install ships" : "is not the one this install ships"}`,
    `  ${v.mine ? "What you told them (read from your repository)" : `${contact}'s claim, not checked here`}:`,
    `    repository    ${safe(k.repo)}`,
    ...(k.pr ? [`    pull request  ${safe(k.pr)}`] : []),
    `    head          ${k.head}`,
    `    base          ${k.base}`,
    `    bindings      sha256 ${k.bindingsHash}`,
    `    trust policy  sha256 ${k.trustPolicyHash}`,
    `    verifier said  ${k.parts.map((p) => `${p.part}: ${p.ok ? "ok" : "failed"}`).join(", ")}`,
    `    CI run        ${k.run ? `${k.run.status}  ${safe(k.run.url)}` : "not given"}`,
    ...(v.mine ? [] : ["  A matching digest shows they named the right bytes. It does not show their repository holds them. Links are text: open them yourself if you choose to."]),
  ].join("\n");
}

const note = (s: string): void => (flags.json ? console.error(s) : console.log(s));

// Which argument of this command names a thread, if any.
function threadArg(): number | undefined {
  if (["say", "log", "propose", "contracts", "contract", "approve", "decline", "withdraw", "pr"].includes(cmd!)) return 0;
  if (cmd === "work") return args[0] === "show" || args[0] === "apply" ? undefined : 0;
  if (cmd === "evidence") return args[0] === "send" ? 1 : 0;
  if ((cmd === "agreement" && args[0] === "export") || (cmd === "repo" && args[0] === "init") || (cmd === "desk" && args[0] === "refill")) return 1;
  return undefined;
}

// A full id, a contact's name (their latest thread), or the start of an id.
function resolveThread(node: Counterpart, ref: string): string {
  const all = node.threads();
  if (all.some((t) => t.id === ref)) return ref;
  const theirs = all.filter((t) => t.contact === ref).sort((a, b) => b.lastAt - a.lastAt);
  if (theirs[0]) {
    if (theirs.length > 1) console.error(`Using your latest thread with ${ref}: ${theirs[0].id} (${safe(theirs[0].goal)})`);
    return theirs[0].id;
  }
  const starts = ref.length >= 4 ? all.filter((t) => t.id.startsWith(ref)) : [];
  if (starts.length > 1) throw new Error(`"${ref}" is the start of ${starts.length} thread ids; give more characters`);
  return starts[0]?.id ?? ref;
}

// Start the background daemon if nothing holds this home. Scripts that run
// their own daemon set CPART_NO_AUTOSTART.
async function ensureDaemon(): Promise<boolean> {
  if (running(home)) return true;
  if (process.env.CPART_NO_AUTOSTART === "1") return false;
  return (await up(home)).state !== undefined;
}

// Everything between a fresh machine and an agent that can talk. Each step
// is skipped when already done, so running it again is harmless.
function portFree(port: number, host: string): Promise<void> {
  return new Promise((ok, no) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => no(new Error(e.code === "EADDRINUSE" ? `port ${port} is already in use. Nothing was made public. Pick another with --port` : e.message)));
    s.listen(port, host, () => s.close(() => ok()));
  });
}

const PRIVATE = /^(localhost$|host\.docker\.internal$|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|0\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:|::ffff:)/i;

let localRelayOk = false; // asked once per run

// A relay address, from --relay or from an invite someone sent. It is
// printed, stored and fetched, so it has to be a plain address and nothing more.
async function relayHealthUrl(relay: string, fromInvite: boolean): Promise<string> {
  if (!/^[\x21-\x7e]{1,512}$/.test(relay)) throw new Error("the relay address has spaces or characters that cannot be shown. Nothing was created.");
  const u = new URL(relay);
  if ((u.protocol !== "ws:" && u.protocol !== "wss:") || u.hash || u.search || u.username || u.password || relay.includes("#") || relay.includes("?") || relay.includes("@")) throw new Error(`a relay address is ws:// or wss://, a host, and nothing after it but a path. Got ${safe(relay)}. Nothing was created.`);
  if (fromInvite) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const found = await lookup(host, { all: true }).then((l) => l.map((x) => x.address), () => [] as string[]);
    if ([host, ...found].some((h) => PRIVATE.test(h) || h.endsWith(".local")) && !flags.yes && !localRelayOk) {
      const typed = await line(`This invite names a relay on your own machine or network: ${safe(relay)}\nSomeone outside your network would not send that. Type yes to use it: `);
      if (typed !== "yes") throw new Error("nothing was created.");
      localRelayOk = true;
    }
  }
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}${u.pathname.replace(/\/$/, "")}/healthz`;
}

// After the daemon starts: did the relay let it in? A relay answers its health
// check to any address, but refuses a login that names an address it was not
// started with. Returns the relay's error code, or null when it logged in or
// nothing was heard in time.
async function loginRefused(node: Counterpart, relay: string, ms = 8000): Promise<string | null> {
  const url = node.relayBook.find(relay)?.url ?? relay;
  const end = Date.now() + ms;
  for (;;) {
    const s = node.relayBook.status().find((x) => x.url === url);
    if (s?.connected) return null;
    const m = s?.error ? /^refused the login: ([a-z_]{1,40})$/.exec(s.error) : null;
    if (m) return m[1]!;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function refusedText(relay: string, code: string, fromInvite: boolean): string {
  if (code === "wrong_relay_url") {
    return [
      `the relay at ${safe(relay)} answers, but refused to log you in (wrong_relay_url): it does not know itself by that address.`,
      "A relay lets in only the addresses it was started with. Started with none, it knows only its own machine's names, like ws://127.0.0.1.",
      `${fromInvite ? "Ask whoever runs it to restart it" : "Restart it"} with --url once for every address people use, this one included:`,
      `  cpart relay ... --url ${safe(relay)} --url <each other address>`,
      "In a container, set CPART_RELAY_URL to the addresses, separated by commas.",
    ].join("\n");
  }
  return `the relay at ${safe(relay)} answers, but refused to log you in (${code}).`;
}

async function setup(relay: string | undefined, fromInvite = false): Promise<Counterpart> {
  let node: Counterpart;
  // What was in the home before this run, so a new identity the relay refuses can be taken away again.
  let made: Set<string> | null | undefined;
  if (existsSync(join(home, "keys.json"))) {
    node = Counterpart.open(home);
    if (relay && !node.relayBook.find(relay)) throw new Error(`your identity in ${home} does not use the relay ${safe(relay)}. To use it as well: cpart relay add ${safe(relay)}`);
    note(`ok  identity ${node.me.human}`);
  } else {
    if (!relay) throw new Error("there is no identity here yet, and making one needs a relay.\n  cpart setup --relay <wss://host>     if you have a relay\n  cpart join <invite> <name>           if someone sent you an invite\n  cpart relay --tunnel                 to run a relay yourself and try it");
    let health = await relayHealthUrl(relay, fromInvite);
    // From inside a container, the machine it runs on has another name. See relays.ts.
    const reach = await reachable(relay);
    if (reach.as) {
      // The other name is checked too: it is what gets dialled.
      health = await relayHealthUrl(reach.relay, fromInvite);
      note(`ok  ${safe(reach.as)} is ${safe(reach.relay)} from here`);
      relay = reach.relay;
    }
    // A new public name can take a few seconds to resolve everywhere.
    let ok = false;
    let why = "";
    for (let i = 0; i < 4 && !ok; i++) {
      if (i) await new Promise((r) => setTimeout(r, 3000));
      ok = await fetch(health, { signal: AbortSignal.timeout(8000), redirect: "error" }).then((r) => r.ok, (e: Error & { cause?: { code?: string } }) => ((why = e.cause?.code ?? e.message), false));
    }
    if (!ok) throw new Error(`no relay answers at ${safe(relay)}${why ? ` (${why})` : ""}. Nothing was created.`);
    note(`ok  relay ${safe(relay)} answers`);
    const passphrase = flags["no-passphrase"] ? undefined : await newPassphrase();
    made = existsSync(home) ? new Set(readdirSync(home)) : null;
    node = await Counterpart.init(home, { relay, ...(reach.as ? { relayAs: reach.as } : {}), ...(passphrase !== undefined ? { passphrase } : {}) });
    note(`ok  identity ${node.me.human} created in ${home}${passphrase === undefined ? " (no passphrase: it can talk but cannot approve contracts)" : ""}`);
  }
  const d = await up(home, { boot: !flags["no-boot"] });
  if (!d.state) throw new Error(`the daemon did not start. See ${logFile(home)}`);
  const target = relay ?? node.relay;
  const refused = d.state.connected ? null : await loginRefused(node, target);
  if (refused) {
    const why = refusedText(target, refused, fromInvite);
    if (made === undefined) {
      throw new Error(`${why}\nYour identity is unchanged. Your daemon keeps trying and gets in once the relay accepts the address; cpart status shows it. Then run this again.`);
    }
    // A new identity that cannot log in is no use. Take back what this run made.
    await down(home);
    node.close();
    if (made === null) rmSync(home, { recursive: true, force: true });
    else for (const f of readdirSync(home)) if (!made.has(f)) rmSync(join(home, f), { recursive: true, force: true });
    throw new Error(`${why}\nNothing was kept. Run this again once the relay is restarted.`);
  }
  note(`${d.state.connected ? "ok" : "--"}  daemon ${d.started ? "started" : "running"}${d.state.connected ? ", connected" : `, but not connected to ${node.relay} yet`}${d.boot ? ", starts at login" : ""}`);
  if (!flags["no-agents"]) {
    const hosts = registerAgents(home);
    for (const h of hosts) {
      if (!h.found) continue;
      note(
        h.registered === "here" ? `ok  ${h.name} ${h.added ? "now has" : "already has"} the counterpart tools${h.added ? ". Sessions started from now on see them" : ""}`
        : h.registered === "elsewhere" ? `--  ${h.name} already has a server named counterpart for another identity or install. It was left alone, so its sessions do not speak for this one. To switch: ${h.bin} mcp remove counterpart, then cpart setup`
        : `--  ${h.name}: could not add the tools (${safe(h.error ?? "unknown error")}). By hand: see docs/mcp.md`,
      );
    }
    if (!hosts.some((h) => h.found)) note("--  neither claude nor codex is on your PATH. Add the MCP server by hand: see docs/mcp.md");
    if (!flags["no-hooks"]) for (const l of hookLines(installHooks(home), safe)) note(l);
  }
  return node;
}

function status(node: Counterpart): void {
  const d = running(home);
  const days = Math.floor((node.credentialExpiresAt - Date.now()) / 86_400_000);
  const hosts = agents(home);
  const contacts = node.contacts();
  const desk = new FrontDesk(node, async () => "");
  const desks = new Map(desk.desks().map((x) => [x.contact, x.enabled]));
  const asks = desk.asks(200).filter((a) => a.state === "open");
  const threads = node.threads();
  const toSign = threads.flatMap((t) => node.contracts(t.id).filter((c) => c.status === "open" && !c.approvedByMe).map((c) => ({ thread: t, c })));
  const agreed = threads.flatMap((t) => node.contracts(t.id).filter((c) => c.status === "agreed")).length;
  const pending = contacts.filter((c) => c.state === "pending");
  const guard = node.guard.counts();
  const waiting = [
    ...(guard.held ? [`  ${guard.held} message${guard.held > 1 ? "s" : ""} held by the outbound guard. Nothing was sent\n      cpart held`] : []),
    ...toSign.map(({ thread, c }) => `  contract to read, ${c.approvedByThem ? `signed by ${thread.contact}` : c.proposedByMe ? "proposed by your side" : `proposed by ${thread.contact}`}: ${safe(c.contract.title)}\n      cpart contract ${thread.id.slice(0, 8)} ${c.proposalId.slice(0, 8)}`),
    ...(asks.length ? [`  ${asks.length} question${asks.length > 1 ? "s" : ""} your front desk could not answer\n      cpart asks`] : []),
    ...pending.map((c) => `  pairing with ${c.name} has not completed; it does when both daemons are online`),
    ...relayNotices(node, safe),
    ...(node.protected && days < 30 ? [`  device credential runs out in ${days} days\n      cpart renew`] : []),
    ...pairingLines(home),
  ];
  const lines = [
    `You       ${node.me.human}  (key ${node.me.rootKey.slice(0, 12)})${node.protected ? "" : "  no passphrase: cannot approve contracts"}`,
    `Relay     ${safe(node.relay)}${node.relayBook.mine().length > 1 ? ` and ${node.relayBook.mine().length - 1} more (cpart relay list)` : ""}`,
    `Daemon    ${d ? `running, ${d.connected ? "connected" : "NOT connected to the relay"}${bootInstalled(home) ? ", starts at login" : ""}` : "NOT running. Nothing is sent or received. Start it: cpart up"}`,
    `Agents    ${hosts.filter((h) => h.found).map((h) => `${h.name}: ${h.registered === "here" ? "has the tools" : h.registered === "elsewhere" ? "has the tools for ANOTHER identity" : "not added (cpart setup adds it)"}`).join("; ") || "neither claude nor codex found on PATH"}`,
    `Contacts  ${contacts.length ? contacts.map((c) => `${c.name}${c.state === "pending" ? " (pending)" : ""}${desks.get(c.name) ? " (front desk on)" : ""}`).join(", ") : "none yet. Pair with: cpart invite <name>"}`,
    `Threads   ${threads.length}${agreed ? `, ${agreed} agreement${agreed > 1 ? "s" : ""} signed by both` : ""}`,
    `Guard     ${node.guard.off ? "OFF (cpart guard on turns it back on)" : "on"}, ${guard.held} held${guard.unguarded ? `, ${guard.unguarded} sent unchecked that it would have held` : ""}${node.guard.problems().length ? ". Some things are NOT CHECKED: see cpart guard" : ""}`,
    "",
    waiting.length ? `Waiting for you:\n${waiting.join("\n")}` : "Nothing is waiting for you.",
  ];
  out(lines.join("\n"), { me: node.me, daemon: d ?? null, boot: bootInstalled(home) ?? null, agents: hosts, contacts: contacts.map((c) => ({ name: c.name, state: c.state })), threads: threads.length, held: guard.held, unguarded: guard.unguarded, toSign: toSign.map(({ thread, c }) => ({ threadId: thread.id, proposalId: c.proposalId, title: c.contract.title })), asks: asks.length });
}

async function main(): Promise<void> {
  if (!cmd || flags.help || cmd === "help") return console.log(USAGE);

  if (cmd === "relay" && !RELAY_SUBCOMMANDS.includes(args[0] ?? "")) {
    const port = Number(flags.port ?? process.env.PORT ?? 7447);
    const host = flags.host ?? "127.0.0.1";
    // A tunnel to a port something else holds would publish that something.
    if (flags.tunnel) await portFree(port, host);
    const tunnel = flags.tunnel ? await openTunnel(port) : undefined;
    const given = flags.url?.length ? flags.url : splitUrls(process.env.CPART_RELAY_URL);
    // Behind a tunnel it answers to the tunnel's address and to --url, never to
    // loopback names by default: those are shared by every machine, and the
    // public address would let a relay elsewhere log in with them. See connectivity.md.
    const urls = tunnel ? [tunnel.url, ...given] : given;
    const relay = await startRelay({ port, host, dbPath: flags.db ?? "relay.db", urls, log: (l) => console.log(l) }).catch((e: Error) => {
      tunnel?.close();
      throw e;
    });
    if (tunnel) console.log(`\nAnyone can reach this relay at ${tunnel.url} until it stops. The address will be different next time.\nYou:   cpart setup --relay ${tunnel.url}\nThem:  cpart join <the invite you send them> <your name>\n`);
    const stop = (): void => {
      tunnel?.close();
      void relay.close().then(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
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

  if (cmd === "setup") {
    const node = await setup(flags.relay ?? process.env.CPART_RELAY);
    const has = node.contacts().length > 0;
    note(has ? "\nReady. See what is waiting for you with: cpart status" : "\nReady. Next, pair with someone:\n  cpart invite <what you call them>      then send them what it prints");
    if (flags.json) console.log(JSON.stringify(node.me));
    return;
  }
  if (cmd === "join") {
    need(2, "join <code or invite> <what you call them>");
    if (looksLikeCode(args[0]!)) return joinByCode(home, args[0]!, args[1]!, { out, note, safe }, (relay) => setup(relay, true));
    const inv = decodeInvite(args[0]!);
    const node = await setup(inv.relay, true);
    const known = node.contacts().find((c) => c.rootKey === inv.credential.rootKey);
    if (known?.state !== "active") {
      if (!known) await node.acceptInvite(args[0]!, args[1]!);
      const name = known?.name ?? args[1]!;
      const end = Date.now() + 20_000;
      while (node.contact(name).state !== "active" && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    }
    const c = node.contact(known?.name ?? args[1]!);
    note(
      c.state === "active"
        ? `\nPaired with ${c.name}. Safety code ${c.safetyCode}: ask ${c.name} to read theirs to you. If the two differ, someone is in the middle.\n\nNow, in Claude Code or Codex, say something like:\n  ask ${c.name}'s agent what their API returns for an empty page`
        : `\nYour request is on its way to ${c.name}. It completes when their daemon is next online: check with cpart status. Safety code ${c.safetyCode}.`,
    );
    if (flags.json) console.log(JSON.stringify(c));
    return;
  }
  if (cmd === "hook") {
    if (args[0] === "install" || args[0] === "remove") {
      const h = args[0] === "install" ? installHooks(home) : removeHooks(home);
      if (!h.claude.found && !h.codex.found) throw new Error("neither claude nor codex is on your PATH");
      for (const l of hookLines(h, safe)) note(l);
      if (h.claude.error || h.codex.error) process.exitCode = 1;
      if (flags.json) console.log(JSON.stringify(h));
      return;
    }
    process.exitCode = await hookMain(args[0] ?? "", home);
    return;
  }
  if (cmd === "down") {
    const was = await down(home);
    return out(was ? "Daemon stopped. It will not start at login." : "No daemon was running.", { stopped: was });
  }
  if (cmd === "status" && !existsSync(join(home, "keys.json"))) {
    return out(`No identity in ${home} yet.\n  cpart setup --relay <wss://host>     if you have a relay\n  cpart join <invite> <name>           if someone sent you an invite`, { identity: false });
  }

  // A held event's missing parents are asked for after 30 seconds. Tests shorten it.
  const resendAfter = process.env.CPART_RESEND_AFTER_MS;
  if (resendAfter !== undefined && !/^[0-9]{1,9}$/.test(resendAfter)) throw new Error("CPART_RESEND_AFTER_MS must be a number of milliseconds");
  const node = Counterpart.open(home, resendAfter !== undefined ? { resendAfterMs: Number(resendAfter) } : {});
  await node.renewIfDue();
  const ti = threadArg();
  if (ti !== undefined && args[ti] !== undefined) args[ti] = resolveThread(node, args[ti]!);
  switch (cmd) {
    case "up": {
      const r = await up(home, { boot: !!flags.boot });
      if (!r.state) throw new Error(`the daemon did not start. See ${logFile(home)}`);
      return out(`Daemon ${r.started ? "started" : "already running"} (pid ${r.state.pid}), ${r.state.connected ? `connected to ${node.relay}` : `not connected to ${node.relay} yet`}.${r.boot ? " It starts at login." : " It stops when this machine restarts; cpart up --boot makes it start at login."}`, r);
    }
    case "status":
      return status(node);
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
    case "repo": {
      if (args[0] !== "init") throw new Error("usage: cpart repo init <thread> <id> --repo <path> --bind <part>=<path>");
      need(3, "repo init <thread> <id> --repo <path> --bind <part>=<path>");
      if (!flags.repo) throw new Error("usage: cpart repo init <thread> <id> --repo <path> --bind <part>=<path>");
      const c = findContract(node, args[1]!, args[2]!);
      const bindings = (flags.bind ?? []).map((spec): Binding => {
        const eq = spec.indexOf("=");
        const [path, valid, invalid] = spec.slice(eq + 1).split(",");
        if (eq < 1 || !path || (valid && !invalid)) throw new Error(`--bind ${spec}: use <part>=<path> or <part>=<path>,<valid dir>,<invalid dir>`);
        return { part: spec.slice(0, eq), path, ...(valid && invalid ? { fixtures: { valid, invalid } } : {}) };
      });
      const written = repoInit(flags.repo, node.agreement(args[1]!, c.proposalId), bindings);
      return out(
        `Wrote in ${flags.repo}:\n${written.map((f) => `  ${f}`).join("\n")}\n\nRead them, then commit them to your main branch. Pull requests are checked against the trust file on that branch, so protect it.`,
        { files: written },
      );
    }
    case "pr": {
      need(2, "pr <thread> <id> --work <work-id>");
      if (!flags.work || !/^[A-Za-z0-9_-]{6,40}$/.test(flags.work) || !existsSync(join(home, "work", `${flags.work}.json`))) throw new Error("usage: cpart pr <thread> <id> --work <work-id>  (the id `cpart work` printed)");
      const w = JSON.parse(readFileSync(join(home, "work", `${flags.work}.json`), "utf8")) as WorkResult & { repo: string };
      const repo = flags.repo ?? w.repo;
      const c = findContract(node, args[0]!, args[1]!);
      const p = preparePublication(repo, node.agreement(args[0]!, c.proposalId), w, flags.branch ? { branch: flags.branch } : {});
      console.error(
        [
          `Repository  ${safe(repo)}`,
          `Pushes to   ${safe(p.remote)}`,
          `Branch      ${safe(p.branch)}  (pull request into ${safe(p.base)})`,
          "Commits     exactly these files:",
          ...p.files.map((f) => `  ${safe(f)}`),
          "",
          "The agreement file holds the full contract text and both root keys. Anyone who can read the repository can read them.",
          "",
          "Checked here the way CI will check it:",
          ...p.check.checks.map((k) => `  ${k.ok ? "ok  " : "FAIL"}  ${safe(k.what)}${k.detail ? `: ${safe(k.detail)}` : ""}`),
          "",
        ].join("\n"),
      );
      if (!p.check.ok) throw new Error("this would fail verification. Nothing was committed or pushed.");
      if (!flags.yes && (await line("Type publish to commit, push and open the pull request: ")) !== "publish") throw new Error("nothing was committed or pushed.");
      const url = publish(repo, p);
      if (!flags.evidence) return out(`Opened ${url}\nTo tell the other side: cpart evidence send ${args[0]} ${c.proposalId} --repo ${safe(repo)} --base ${safe(p.base)} --pr ${safe(url)}`, { url, branch: p.branch, files: p.files });
      // The commit just made, against the commit the work started from.
      const ev = collectEvidence(repo, node.agreement(args[0]!, c.proposalId), { base: w.baseCommit, ...(flags.label ? { label: flags.label } : {}), ...(isHttpsUrl(url) ? { pr: url } : {}) });
      const sent = await node.postEvidence(args[0]!, ev);
      return out(`Opened ${url}\nSent evidence ${sent.id} for head ${ev.head.slice(0, 12)}. A running daemon delivers it.`, { url, branch: p.branch, files: p.files, evidence: ev, eventId: sent.id });
    }
    case "evidence": {
      if (args[0] === "send") {
        const usage = "evidence send <thread> <id> --repo <path> [--head <ref>] [--base <ref>] [--label <owner/name>] [--pr <https url>] [--run <https url> --status success|failure]";
        need(3, usage);
        if (!flags.repo) throw new Error(`usage: cpart ${usage}`);
        if (flags.pr !== undefined && !isHttpsUrl(flags.pr)) throw new Error("--pr must be an https:// URL of at most 300 characters");
        if ((flags.run === undefined) !== (flags.status === undefined)) throw new Error("--run and --status go together");
        let run: Evidence["run"];
        if (flags.run !== undefined) {
          if (!isHttpsUrl(flags.run)) throw new Error("--run must be an https:// URL of at most 300 characters");
          if (flags.status !== "success" && flags.status !== "failure") throw new Error("--status must be success or failure");
          run = { url: flags.run, status: flags.status };
        }
        const c = findContract(node, args[1]!, args[2]!);
        if (c.status !== "agreed") throw new Error("evidence is about an agreement. Both people must approve this proposal first.");
        const ev = collectEvidence(flags.repo, node.agreement(args[1]!, c.proposalId), {
          ...(flags.head ? { head: flags.head } : {}), ...(flags.base ? { base: flags.base } : {}), ...(flags.label ? { label: flags.label } : {}), ...(flags.pr ? { pr: flags.pr } : {}), ...(run ? { run } : {}),
        });
        const sent = await node.postEvidence(args[1]!, ev);
        const mine = node.evidence(args[1]!, c.proposalId).find((v) => v.eventId === sent.id)!;
        const t = node.threads().find((x) => x.id === args[1]);
        return out(`${describeEvidence(mine, t?.contact ?? "them")}\n\nQueued. A running daemon delivers it.${ev.parts.every((p) => p.ok) ? "" : "\nAt least one bound file on this head is not the signed text. The other side will see that."}`, mine);
      }
      need(1, "evidence <thread> [id] | evidence send <thread> <id> --repo <path>");
      const t = node.threads().find((x) => x.id === args[0]);
      if (!t) throw new Error(`no thread ${args[0]}`);
      const only = args[1] ? findContract(node, t.id, args[1]).proposalId : undefined;
      const list = node.evidence(t.id, only);
      if (!list.length) return out(only ? "No evidence for this proposal." : "No evidence in this thread.", list);
      const titles = new Map(node.contracts(t.id).map((c) => [c.proposalId, c.contract.title]));
      const groups = [...new Set(list.map((v) => v.proposalId))].map((id) => {
        const mine = list.filter((v) => v.proposalId === id);
        // Current first, then older ones newest first.
        const ordered = [...mine.filter((v) => v.state === "current"), ...mine.filter((v) => v.state !== "current").reverse()];
        return [`Proposal ${id}  ${safe(titles.get(id) ?? "")}`, "", ...ordered.flatMap((v) => [describeEvidence(v, t.contact), ""])].join("\n");
      });
      return out(groups.join("\n").trimEnd(), list);
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
      const held = claim(home, node.relay);
      const link = new RelayLink(node).start();
      logLink(link, (up) => held.set(up), safe);
      link.on("error", (e) => console.error(`error: ${safe(e.message)}`));
      link.on("verdict", (v) => {
        if (v.result === "rejected") console.log(`refused a message: ${safe(v.reason)}`);
      });
      link.on("event", (e) => console.log(`${e.type} in thread ${e.threadId}`));
      const pairing = new PairingEngine(node, link).start();
      pairing.onLine = (l) => console.log(safe(l));
      // With an API key the model sees exactly what we send. Without one, the
      // claude CLI is used with a subscription login; it adds a few values of its
      // own, which are filtered out of replies.
      const key = process.env.ANTHROPIC_API_KEY;
      const pick = flags.model ? { model: flags.model } : {};
      const base = process.env.ANTHROPIC_BASE_URL ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {};
      const desk = key ? new FrontDesk(node, anthropicApi({ apiKey: key, ...base, ...pick })) : new FrontDesk(node, claudeCli(pick), { forbidden: cliPrivateValues() });
      desk.onError = (e) => console.error(`front desk: ${e.message}`);
      desk.onRun = (r) => console.log(`front desk ${r.outcome} for ${r.contact} in thread ${r.threadId}${r.detail ? `: ${safe(r.detail)}` : ""}`);
      desk.start();
      // The home is given up only once nothing here is still sending.
      const stop = (): void =>
        void Promise.all([link.stop(), desk.stop(), pairing.stop()]).finally(() => {
          held.release();
          process.exit(0);
        });
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "invite": {
      need(1, "invite <name>");
      // The invite completes only while this side is online to answer it.
      const d = await ensureDaemon();
      // Scripts read `invite` from --json, so that stays the long form unless they ask for --code.
      const short = flags.json ? !!flags.code : !flags.long;
      if (short && (await inviteByCode(node, args[0]!, { out, note, safe }, { daemon: d, wait: !flags["no-wait"] && !flags.json }))) return;
      if (short) note(d ? "The relay did not give out a short code, so here is a long invite instead." : "A short code needs the daemon running, so here is a long invite instead.");
      const invite = node.createInvite(args[0]!);
      return out(
        `Send this to ${args[0]}. It works once and expires in 24 hours. They run it, with the name they call you:\n\n  cpart join ${invite} <your name>\n${d ? "" : "\nYour daemon is not running, so their request will wait. Start it with: cpart up\n"}`,
        { invite },
      );
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
          : e.type === "evidence.posted" ? `sent evidence for proposal ${(b.proposalId as string).slice(0, 12)}, head ${(b.head as string).slice(0, 12)}. See: cpart evidence`
          : e.type;
        // One event, one line, stamped with the time it took effect here. The
        // sender's own clock and line breaks are theirs to fake.
        // My own events say how far they have got until the other side's
        // daemon confirms it applied them. After that the line is plain.
        const mark = e.status === "pending" ? "(held) " : e.delivery && e.delivery !== "received" ? `(${e.delivery === "stored" ? "at relay" : e.delivery}) ` : "";
        return `${time(e.receivedAt)}  ${who.padEnd(12)} ${mark}${safe(what)}`;
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
    case "share": {
      const gate = { tty: !!process.stdin.isTTY, yes: !!flags.yes, envPassphrase: process.env.CPART_PASSPHRASE !== undefined, print: (s: string) => console.error(s), line, secret };
      const r = await shareCommand(node, home, args, { ...(flags.repo ? { repo: flags.repo } : {}), ...(flags.allow ? { allow: flags.allow } : {}), all: !!flags.all, safe, gate });
      return out(r.human, r.data);
    }
    case "desk": {
      const desk = new FrontDesk(node, async () => {
        throw new Error("not available here");
      });
      const show = (d: { contact: string; enabled: boolean; owner: string; slotsPerThread: number; slotsPerDay: number }): string =>
        `${d.contact.padEnd(20)} ${d.enabled ? "on " : "off"}  answers as ${d.owner}'s front desk, ${d.slotsPerThread} replies per thread, ${d.slotsPerDay} per day, ${sharedSummary(home, node.contact(d.contact))}`;
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
      if (args[0] === "answer" || args[0] === "dismiss") {
        need(2, `asks ${args[0]} <id>${args[0] === "answer" ? " [text]" : ""}`);
        if (!/^[0-9]{1,15}$/.test(args[1]!)) throw new Error("give the number `cpart asks` prints in its first column");
        const text = args.slice(2).join(" ").trim();
        if (args[0] === "dismiss") {
          if (text) throw new Error("dismiss sends nothing. To reply, use: cpart asks answer <id> <text>");
          const a = desk.dismissAsk(Number(args[1]));
          return out(`Question ${a.id} dismissed. Nothing was sent to ${a.contact}.`, a);
        }
        const a = await desk.answerAsk(Number(args[1]), text || undefined);
        return out(text ? `Question ${a.id} answered. Your message to ${a.contact} is queued in thread ${a.threadId}.` : `Question ${a.id} marked answered. Nothing was sent to ${a.contact}.`, a);
      }
      if (args[0]) throw new Error("usage: cpart asks [--all] | cpart asks answer <id> [text] | cpart asks dismiss <id>");
      const all = desk.asks(200);
      const list = flags.all ? all : all.filter((a) => a.state === "open");
      const row = (a: (typeof all)[number]): string => `${String(a.id).padStart(3)}  ${time(a.at)}  ${a.contact.padEnd(12)} ${flags.all ? a.state.padEnd(10) : ""}thread ${a.threadId}  ${safe(a.question)}`;
      const none = all.length ? "No open questions. See the closed ones with: cpart asks --all" : "The front desk has not passed you any questions.";
      return out(list.length ? `${list.map(row).join("\n")}\n\nThe wording came from a model that read the other side's messages. Answer with: cpart asks answer <id> <text>` : none, list);
    }
    case "mcp":
      // A session that can talk needs the daemon to carry what it says.
      await ensureDaemon();
      await startMcpServer(node, flags.notify || process.env.CPART_NOTIFY === "1" ? { notify: { log: (l) => console.error(`counterpart mcp: ${l}`), viewerPort: Number(flags["view-port"] ?? process.env.CPART_VIEW_PORT ?? 7450) } } : {});
      return;
    case "view": {
      const viewer = await startViewer(node, flags.port ? { port: Number(flags.port) } : {});
      console.log(`Open ${viewer.url}\nThe link carries a key. Anyone who has it and can reach this machine's loopback address can read your threads.`);
      const stop = () => void viewer.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "held":
    case "release":
    case "drop":
    case "guard":
      return guardCommand(cmd, { node, args, flags, out, safe, time });
    case "relay":
      return relayCommand(node, args, { out, note, safe, ensureDaemon, flags: { ...(flags.as ? { as: flags.as } : {}), ...(flags.wait ? { wait: flags.wait } : {}), ...(flags.yes ? { yes: true } : {}) } });
    case "rejects": {
      const list = node.rejects();
      return out(list.length ? list.map((r) => `${time(r.at)}  ${safe(r.reason)}`).join("\n") : "Nothing has been refused.", list);
    }
    default:
      throw new Error(`unknown command "${cmd}". Run: cpart help`);
  }
}

// Anything that escapes main() is a bug. Say which command hit it and keep the
// stack, so a failure that happens once can still be traced.
for (const kind of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(kind, (e: unknown) => {
    console.error(`cpart ${cmd ?? ""}: ${kind} (pid ${process.pid}, home ${home})\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(70);
  });
}

main().catch((e: Error) => {
  console.error(`cpart: ${e.message}`);
  process.exit(1);
});
