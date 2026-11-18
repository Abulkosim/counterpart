// `cpart held`, `cpart release`, `cpart drop` and `cpart guard`: what the
// outbound guard stopped, and the owner's say over it. Releasing, dropping,
// adding or removing a never-share file, removing a repository and turning
// the guard off need the owner at a terminal: the passphrase is read from the
// keyboard only, never from CPART_PASSPHRASE, so an agent that can run
// commands on this machine cannot do them. On an identity made without a
// passphrase nothing can tell the owner from an agent: release and off are
// refused there, and the rest is allowed, so a missing file cannot stop all
// sending for good.

import type { Counterpart, Finding, Held } from "@counterpart/daemon";

export interface Kit {
  node: Counterpart;
  args: string[];
  flags: { json?: boolean; all?: boolean };
  out: (human: string, data: unknown) => void;
  safe: (s: string) => string;
  time: (ms: number) => string;
}

export const GUARD_USAGE = `Outbound guard: everything you or your agent send is checked first. A message
that carries a key, a token, a value from your environment or .env files, or
text from a file you marked never-share is held, not sent.

  cpart held [--all]                                              messages held and not sent. --all adds released, dropped and unguarded
  cpart release <id>                                              show it in full and send it. Needs you at a terminal, with your passphrase
  cpart drop <id>                                                 delete it. Nothing is sent. Needs you at a terminal
  cpart guard                                                     what is checked
  cpart guard repo add|remove <path>                              also check the .env files in this repository
  cpart guard never-share add|remove <file>                       hold any message that quotes this file
  cpart guard off <minutes>                                       send without checking for a while (at most 8 hours)
  cpart guard on                                                  check again
  Removing a repository, never-share files and guard off need you at a terminal, like release.`;

const DESCRIBE: Record<string, string> = {
  "private-key": "a private key",
  "cloud-credential": "a cloud provider credential",
  jwt: "a JSON Web Token",
  "api-token": "an API key or token of a known service",
  "generic-secret": "a value that looks like a secret",
  "env-secret": "the value of a secret-named variable in the sending program's environment",
  "dotenv-value": "a value from a .env file",
  "config-value": "a value under a secret name in a config or credentials file",
  "never-share-file": "text from a file you marked never-share",
  "too-much-to-check": "more encoded text than the guard will decode, so part of it went unchecked",
  "never-share-unreadable": "a never-share file that cannot be read now (restore it, or remove it with cpart guard never-share remove)",
};

const HOW: Record<string, string> = {
  plain: "as it is",
  reversed: "reversed",
  split: "split up with separators",
  base64: "in base64",
  hex: "in hex",
  url: "percent-encoded",
  escaped: "with escapes",
  rot13: "in rot13",
  folded: "in full-width letters",
  base32: "in base32",
  codes: "as character codes",
  entities: "as HTML character references",
  octal: "as octal escapes",
  binary: "in binary",
  part: "in part",
  "across messages": "spread over this and earlier messages",
};
const how = (h: string): string => h.split(">").map((x) => HOW[x] ?? x).join(", then ");

// The rule, in words. Paths in rule names are the owner's own.
function source(f: Finding): string {
  if (f.rule.startsWith("env:")) return `$${f.rule.slice(4)}`;
  if (f.rule.startsWith("dotenv:")) {
    const rest = f.rule.slice(7);
    const i = rest.lastIndexOf(":");
    return `${rest.slice(i + 1)} in ${rest.slice(0, i)}`;
  }
  if (f.rule.startsWith("never-share:")) return f.rule.slice(12);
  return `rule ${f.rule}`;
}

function fields(body: unknown, path = ""): { field: string; text: string }[] {
  if (typeof body === "string") return [{ field: path || "body", text: body }];
  if (Array.isArray(body)) return body.flatMap((x, i) => fields(x, path ? `${path}.${i}` : String(i)));
  if (body && typeof body === "object") return Object.entries(body as Record<string, unknown>).flatMap(([k, v]) => fields(v, path ? `${path}.${k}` : k));
  return [];
}

// One line of a held message with what matched blanked out, for lists.
function preview(h: Held, safe: (s: string) => string): string {
  const first = fields(h.body).find((f) => f.text.trim());
  if (!first) return "";
  let text = first.text;
  const here = h.findings.filter((f) => f.field === first.field);
  // A finding that could not be placed covers the whole field, unless the same
  // rule also matched at a known place: then that place is what to blank.
  const placed = (f: Finding): boolean => f.end - f.start < first.text.length;
  const spans = here.filter((f) => placed(f) || !here.some((g) => g.rule === f.rule && placed(g)));
  // Blank from the end so earlier offsets stay right; overlapping spans merge.
  const merged: [number, number][] = [];
  for (const s of spans.map((f): [number, number] => [f.start, f.end]).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push(s);
  }
  for (const [s, e] of merged.reverse()) text = `${text.slice(0, s)}[...]${text.slice(e)}`;
  const line = safe(text.replace(/\s+/g, " ").trim());
  return line.length > 70 ? `${line.slice(0, 70)}...` : line;
}

const contactName = (node: Counterpart, root: string): string => node.contacts().find((c) => c.rootKey === root)?.name ?? "an unknown contact";

// Read a line with echo off, from the keyboard only.
async function typed(prompt: string, hidden: boolean): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("this needs you at a terminal. Nothing was sent or changed.");
  if (hidden) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stderr.write(prompt);
  try {
    return await new Promise<string>((resolve, reject) => {
      let buf = "";
      const onData = (d: Buffer): void => {
        for (const ch of d.toString("utf8")) {
          if (ch === "\r" || ch === "\n") {
            process.stdin.off("data", onData);
            if (hidden) process.stderr.write("\n");
            return resolve(buf);
          }
          if (ch === "\u0003") return reject(new Error("cancelled. Nothing was sent or changed."));
          if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
          else if (ch >= " ") buf += ch;
        }
      };
      process.stdin.on("data", onData);
    });
  } finally {
    if (hidden) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

// The owner at a terminal, on an identity with a passphrase. Without one,
// nothing can tell the owner from an agent, and nothing is asked.
async function ownerWhereThereIsOne(node: Counterpart): Promise<void> {
  if (node.protected) await owner(node);
}

// The owner, at this terminal, typing their passphrase. An identity without
// one cannot do this: nothing would tell its owner from an agent that can
// drive a terminal.
async function owner(node: Counterpart): Promise<string> {
  if (!node.protected) throw new Error("this identity was made without a passphrase, so nothing here can tell you from an agent, and this cannot be done. Nothing was sent or changed.");
  if (!process.stdin.isTTY) throw new Error("this needs you at a terminal, typing. It does not read CPART_PASSPHRASE. Nothing was sent or changed.");
  const p = await typed("Your passphrase: ", true);
  node.checkPassphrase(p);
  return p;
}

export async function guardCommand(cmd: string, kit: Kit): Promise<void> {
  const { node, args, flags, out, safe, time } = kit;
  const g = node.guard;

  if (cmd === "held") {
    const list = g.held(!!flags.all);
    const row = (h: Held): string =>
      `${h.id}  ${time(h.at)}  ${contactName(node, h.contactRoot).padEnd(12)} ${h.type.padEnd(17)} ${flags.all ? h.state.padEnd(10) : ""}${h.reasons.join(", ")}${h.body !== null ? `  ${preview(h, safe)}` : ""}`;
    const none = flags.all ? "The guard has held nothing." : "Nothing is held. See older ones with: cpart held --all";
    const view = list.map((h) => ({ ...h, body: undefined, preview: h.body !== null ? preview(h, safe) : null }));
    return out(list.length ? `${list.map(row).join("\n")}${flags.all ? "" : "\n\nRead one in full and send it: cpart release <id>. Throw it away: cpart drop <id>"}` : none, view);
  }

  if (cmd === "drop") {
    if (!args[0]) throw new Error("usage: cpart drop <id>");
    // An agent must not hide its own attempt from the owner.
    g.find(args[0]);
    await ownerWhereThereIsOne(node);
    const h = g.drop(args[0]);
    return out(`Dropped ${h.id}. Nothing was sent to ${contactName(node, h.contactRoot)}.`, { id: h.id, state: "dropped" });
  }

  if (cmd === "release") {
    if (!args[0]) throw new Error("usage: cpart release <id>");
    if (!node.protected) throw new Error("this identity was made without a passphrase, so nothing here can tell you from an agent, and held messages cannot be released. Drop it with cpart drop, and send what you meant in words that do not carry the secret.");
    if (!process.stdin.isTTY) throw new Error("cpart release needs you at a terminal, typing. It does not read CPART_PASSPHRASE. Nothing was sent.");
    const h = g.find(args[0]);
    if (h.state !== "held" && h.state !== "releasing") throw new Error(`${h.id} is ${h.state}, not held. Nothing was sent.`);
    const name = contactName(node, h.contactRoot);
    const lines = [
      `Held ${h.id} at ${time(h.at)}: ${h.type} to ${name}${h.threadId ? ` in thread ${h.threadId}` : " (it opens a new thread)"}`,
      `Why: ${h.reasons.map((r) => DESCRIBE[r] ?? r).join("; ")}`,
      "",
    ];
    for (const f of fields(h.body)) {
      const hits = h.findings.filter((x) => x.field === f.field);
      lines.push(`  ${f.field}:`);
      lines.push(...f.text.split("\n").map((l) => `    ${safe(l)}`));
      for (const x of hits) {
        const part = x.end - x.start < f.text.length ? `, characters ${x.start + 1} to ${x.end}: ${safe(f.text.slice(x.start, x.end).slice(0, 200))}` : "";
        lines.push(`  matched: ${DESCRIBE[x.category] ?? x.category} (${safe(source(x))}), written ${how(x.how)}${part}`);
      }
      lines.push("");
    }
    lines.push(`Releasing sends all of the above to ${name}, exactly as shown. It cannot be called back.`);
    console.error(lines.join("\n"));
    const passphrase = await owner(node);
    const r = await node.releaseHeld(h.id, passphrase);
    return out(`Sent ${h.id} as event ${r.eventId} in thread ${r.threadId}. A running daemon delivers it.`, { id: h.id, eventId: r.eventId, threadId: r.threadId });
  }

  // cpart guard ...
  const [what, verb, path] = args;
  if (what === "off") {
    const minutes = Number(verb);
    if (!verb || !/^\d+$/.test(verb)) throw new Error("usage: cpart guard off <minutes>");
    if (!node.protected) throw new Error("this identity was made without a passphrase, so nothing here can tell you from an agent, and the guard cannot be turned off. Nothing was changed.");
    console.error(`Turning the guard off sends everything from this identity unchecked for ${minutes} minute${minutes === 1 ? "" : "s"}, from any program, agents included. Each message is still recorded. End it early with: cpart guard on`);
    const passphrase = await owner(node);
    const until = node.guardOff(minutes, passphrase);
    return out(`The guard is off until ${time(until)}. Turn it back on with: cpart guard on`, { off: true, until });
  }
  if (what === "on") {
    const was = g.clearOff();
    return out(was ? "The guard is on again." : "The guard was on.", { off: g.off });
  }
  if (!what || what === "status") {
    const c = g.counts();
    const until = g.offUntil();
    const repos = g.paths("repo");
    const files = g.paths("never-share");
    return out(
      [
        `Guard     ${until !== null ? `OFF until ${time(until)} (cpart guard on turns it back on). Messages it would hold are sent and recorded` : g.off ? "OFF in this process. Messages it would hold are sent and recorded" : "on"}`,
        `Held      ${c.held} message${c.held === 1 ? "" : "s"}${c.unguarded ? `; ${c.unguarded} sent unchecked while it was off that it would have held` : ""}`,
        "Checks    keys and tokens of known shapes (gitleaks rules), private key blocks, passwords in URLs,",
        "          secret-named variables in the sending program's environment, .env files in the",
        "          sender's repository and in these, and text from these never-share files.",
        `Repos     ${repos.length ? repos.map(safe).join(", ") : "none added (cpart guard repo add <path>)"}`,
        `Never-share ${files.length ? files.map(safe).join(", ") : "none (cpart guard never-share add <file>)"}`,
        ...g.problems().map((p) => `NOT CHECKED ${safe(p)}`),
      ].join("\n"),
      { off: g.off, offUntil: until, ...c, repos, neverShare: files, problems: g.problems() },
    );
  }
  if ((what !== "repo" && what !== "never-share") || (verb !== "add" && verb !== "remove") || !path) throw new Error(`usage:\n${GUARD_USAGE}`);
  if (verb === "add") {
    // A never-share file that later goes missing holds everything, so only
    // the owner may add one; otherwise an agent could add a file and delete it.
    if (what === "never-share") await ownerWhereThereIsOne(node);
    const abs = g.addPath(what, path);
    return out(what === "repo" ? `Messages that carry a value from a .env file in ${safe(abs)} will be held.` : `Messages that quote ${safe(abs)} will be held.`, { kind: what, path: abs });
  }
  // Taking a protection away is the owner's call, the same as releasing.
  if (!g.paths(what).some((p) => p === path || p.endsWith(`/${path}`))) throw new Error(`${safe(path)} is not on the list. See: cpart guard`);
  await ownerWhereThereIsOne(node);
  const gone = g.removePath(what, path) || g.removePath(what, g.paths(what).find((p) => p.endsWith(`/${path}`)) ?? path);
  return out(gone ? `Removed ${safe(path)}.` : `${safe(path)} was not on the list.`, { kind: what, path, removed: gone });
}
