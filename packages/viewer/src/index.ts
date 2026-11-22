import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContractStatus, ContractView, Counterpart, EvidenceView, StoredEvent, ThreadSummary } from "@counterpart/daemon";
import { type Run, FrontDesk, readBundle } from "@counterpart/frontdesk";
import { deviceId, humanId } from "@counterpart/protocol";
import { type DiffLine, diffLines } from "./diff.ts";

export { type DiffLine, diffLines } from "./diff.ts";

export interface ViewerOptions {
  port?: number;
  host?: string;
}

export interface Viewer {
  url: string;
  close(): Promise<void>;
}

export interface ViewerEvent {
  id: string;
  type: string;
  mine: boolean;
  status: "applied" | "pending";
  createdAt: number;
  receivedAt: number;
  text: string | null; // what was said, the goal, or the reason given for a decline
  via: "human" | "agent" | "frontdesk" | null; // the sender's own claim
  proposalId: string | null; // the proposal a contract event is about
}

// One proposal without its text. `n` counts proposals in the order this
// machine applied them, so a person can say "proposal 2".
export interface ViewerProposal {
  n: number;
  proposalId: string;
  hash: string;
  title: string;
  status: ContractStatus;
  proposedByMe: boolean;
  proposedAt: number;
  supersedes: string | null;
  replacedBy: string[];
  approvedByMe: boolean;
  approvedByThem: boolean;
  declinedBy: ("me" | "them")[];
  declineReason: string | null;
  withdrawn: boolean;
  parts: { name: string; kind: string; bytes: number }[];
}

export interface ViewerThreadSummary extends ThreadSummary {
  toSign: number; // open proposals the owner has not signed
  agreed: number;
  broken: boolean; // stored proposals no longer match their hashes
}

export type ViewerNeed =
  | { kind: "sign" | "waiting"; at: number; threadId: string; contact: string; proposalId: string; n: number; title: string; proposedByMe: boolean; approvedByThem: boolean; status: ContractStatus }
  | { kind: "ask"; id: number; at: number; threadId: string; contact: string; question: string };

export interface ViewerOverview {
  me: { human: string; device: string; relay: string; rootKey: string; home: string; protected: boolean; credentialExpiresAt: number };
  threads: ViewerThreadSummary[];
  contacts: { name: string; state: "pending" | "active"; safetyCode: string; human: string; device: string; relay: string; credentialExpiresAt: number }[];
  rejects: { at: number; reason: string; wireId: string | null }[];
  needs: ViewerNeed[];
}

export interface ViewerThread {
  thread: ThreadSummary;
  events: ViewerEvent[];
  proposals: ViewerProposal[] | null; // null when the stored proposals cannot be trusted
}

export interface ViewerPartDiff {
  name: string;
  change: "same" | "changed" | "added" | "removed";
  kindWas: string | null; // set when the same name now carries another kind
  lines: DiffLine[] | null;
}

export interface ViewerContract {
  thread: ThreadSummary;
  canSign: boolean;
  proposal: Omit<ViewerProposal, "parts"> & {
    text: string;
    parts: { name: string; kind: string; bytes: number; sha256: string; content: string }[];
    signedByMeAt: number | null;
    signedByThemAt: number | null; // when their signature arrived here
  };
  proposals: { n: number; proposalId: string; proposedByMe: boolean }[];
  previous: { n: number; proposalId: string; proposedByMe: boolean; titleWas: string | null } | null;
  diff: { text: DiffLine[]; parts: ViewerPartDiff[] } | null;
  // Evidence from both sides, oldest first. `claim` is the sender's word;
  // `checked` is what this machine recomputed from the signed contract.
  evidence: EvidenceView[];
}

export interface ViewerFrontDesk {
  desks: { contact: string; enabled: boolean; owner: string; slotsPerThread: number; slotsPerDay: number; files: { name: string; bytes: number; sha256: string }[] }[];
  runs: Run[];
}

export interface ViewerBundleFile {
  contact: string;
  name: string;
  bytes: number;
  sha256: string;
  text: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const PUBLIC = new URL(import.meta.url.endsWith(".ts") ? "../public/" : "./viewer/", import.meta.url);
const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};
const ID = "[A-Za-z0-9_-]{16,64}";
const ROUTES = {
  thread: new RegExp(`^/api/threads/(${ID})$`),
  contract: new RegExp(`^/api/threads/(${ID})/contracts/(${ID})$`),
  bundleFile: /^\/api\/frontdesk\/bundles\/([a-z0-9][a-z0-9._-]{0,31})\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/,
};
const MAX_DIFFS = 64;

// Nothing inline and nothing from another origin. Peer text is only ever set
// as text, so this is the second line of defence, not the first.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cache-Control": "no-store",
};

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function toEvent(e: StoredEvent): ViewerEvent {
  const body = e.body as { text?: unknown; goal?: unknown; via?: unknown; reason?: unknown; proposalId?: unknown; approval?: { proposalId?: unknown } };
  const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
  const text = e.type === "talk.posted" ? str(body.text) : e.type === "thread.opened" ? str(body.goal) : e.type === "contract.declined" ? str(body.reason) : null;
  const proposalId =
    e.type === "contract.proposed" ? e.id
    : e.type === "contract.accepted" ? str(body.approval?.proposalId)
    : e.type === "contract.declined" || e.type === "contract.withdrawn" || e.type === "evidence.posted" ? str(body.proposalId)
    : null;
  const via = e.type === "talk.posted" && (body.via === "human" || body.via === "agent" || body.via === "frontdesk") ? body.via : null;
  return { id: e.id, type: e.type, mine: e.mine, status: e.status, createdAt: e.createdAt, receivedAt: e.receivedAt, text, via, proposalId };
}

function toProposals(views: ContractView[]): ViewerProposal[] {
  return views.map((c, i) => ({
    n: i + 1, proposalId: c.proposalId, hash: c.hash, title: c.contract.title, status: c.status, proposedByMe: c.proposedByMe, proposedAt: c.proposedAt,
    supersedes: c.supersedes, replacedBy: views.filter((x) => x.supersedes === c.proposalId).map((x) => x.proposalId),
    approvedByMe: c.approvedByMe, approvedByThem: c.approvedByThem, declinedBy: c.declinedBy, declineReason: c.declineReason, withdrawn: c.withdrawn,
    parts: c.contract.parts.map((p) => ({ name: p.name, kind: p.kind, bytes: Buffer.byteLength(p.content) })),
  }));
}

function diffContracts(from: ContractView, to: ContractView): NonNullable<ViewerContract["diff"]> {
  const before = new Map(from.contract.parts.map((p) => [p.name, p]));
  const names = new Set(to.contract.parts.map((p) => p.name));
  const parts = to.contract.parts.map((p): ViewerPartDiff => {
    const was = before.get(p.name);
    if (!was) return { name: p.name, change: "added", kindWas: null, lines: null };
    const kindWas = was.kind === p.kind ? null : was.kind;
    if (was.content === p.content) return { name: p.name, change: kindWas ? "changed" : "same", kindWas, lines: null };
    return { name: p.name, change: "changed", kindWas, lines: diffLines(was.content, p.content) };
  });
  for (const p of from.contract.parts) if (!names.has(p.name)) parts.push({ name: p.name, change: "removed", kindWas: null, lines: null });
  return { text: diffLines(from.contract.text, to.contract.text), parts };
}

// Serves a read-only page for one local identity. The page and its data are
// reachable only from this machine, only under the address the server chose,
// and the data only with the token in the returned URL.
export async function startViewer(node: Counterpart, opts: ViewerOptions = {}): Promise<Viewer> {
  const host = opts.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new Error("the viewer only listens on this machine: host must be 127.0.0.1 or ::1");
  const token = randomBytes(32).toString("base64url");
  const wanted = digest(`Bearer ${token}`);
  let hosts = new Set<string>();

  // Opened only to read what the front desk recorded. Its model is never
  // called: the viewer does not run the desk.
  const desk = new FrontDesk(node, async () => {
    throw new Error("read only");
  });
  const diffs = new Map<string, NonNullable<ViewerContract["diff"]>>();

  // Null when a stored proposal no longer matches its hash. Nothing from such
  // a thread is offered for signing.
  const contracts = (threadId: string): ContractView[] | null => {
    try {
      return node.contracts(threadId);
    } catch {
      return null;
    }
  };

  // Open means not answered, not dismissed, and the owner has not written in
  // that thread since. The front desk's own record decides.
  const openAsks = (): ViewerNeed[] =>
    desk.asks(200).filter((a) => a.state === "open").map((a) => ({ kind: "ask", id: a.id, at: a.at, threadId: a.threadId, contact: a.contact, question: a.question }));

  const overview = (): ViewerOverview => {
    const needs: ViewerNeed[] = [];
    const threads = node.threads().map((t): ViewerThreadSummary => {
      const views = contracts(t.id);
      const list = toProposals(views ?? []);
      for (const p of list) {
        const kind = p.status === "open" && !p.approvedByMe ? "sign" : p.approvedByMe && !p.approvedByThem ? "waiting" : null;
        if (kind) needs.push({ kind, at: p.proposedAt, threadId: t.id, contact: t.contact, proposalId: p.proposalId, n: p.n, title: p.title, proposedByMe: p.proposedByMe, approvedByThem: p.approvedByThem, status: p.status });
      }
      return { ...t, toSign: list.filter((p) => p.status === "open" && !p.approvedByMe).length, agreed: list.filter((p) => p.status === "agreed").length, broken: views === null };
    });
    needs.push(...openAsks());
    needs.sort((a, b) => b.at - a.at);
    return {
      me: { human: node.me.human, device: node.me.device, relay: node.me.relay, rootKey: node.me.rootKey, home: node.home, protected: node.protected, credentialExpiresAt: node.credentialExpiresAt },
      threads,
      contacts: node.contacts().map((c) => ({
        name: c.name, state: c.state, safetyCode: c.safetyCode, human: humanId(c.rootKey), device: deviceId(c.credential),
        relay: c.relay, credentialExpiresAt: c.credential.expiresAt,
      })),
      rejects: node.rejects(200),
      needs,
    };
  };

  const thread = (id: string): ViewerThread | null => {
    const t = node.threads().find((x) => x.id === id);
    if (!t) return null;
    const views = contracts(id);
    return { thread: t, events: node.log(id).map(toEvent), proposals: views && toProposals(views) };
  };

  const contract = (threadId: string, proposalId: string): ViewerContract | null => {
    const t = node.threads().find((x) => x.id === threadId);
    const views = t && contracts(threadId);
    const view = views?.find((c) => c.proposalId === proposalId);
    if (!t || !views || !view) return null;
    const list = toProposals(views);
    const summary = list.find((p) => p.proposalId === proposalId)!;
    const from = view.supersedes ? views.find((c) => c.proposalId === view.supersedes) : undefined;

    let diff: ViewerContract["diff"] = null;
    if (from) {
      diff = diffs.get(proposalId) ?? diffContracts(from, view);
      if (diffs.size >= MAX_DIFFS) diffs.clear();
      diffs.set(proposalId, diff);
    }
    const signed = (mine: boolean): number | null => {
      const e = node.log(threadId).find((x) => x.type === "contract.accepted" && x.status === "applied" && x.mine === mine && (x.body as { approval: { proposalId: string } }).approval.proposalId === proposalId);
      return e ? (mine ? e.createdAt : e.receivedAt) : null;
    };
    const previous = from && list.find((p) => p.proposalId === from.proposalId)!;
    return {
      thread: t,
      canSign: node.protected,
      proposal: {
        ...summary,
        text: view.contract.text,
        parts: view.contract.parts.map((p) => ({ name: p.name, kind: p.kind, bytes: Buffer.byteLength(p.content), sha256: sha256(p.content), content: p.content })),
        signedByMeAt: signed(true),
        signedByThemAt: signed(false),
      },
      proposals: list.map((p) => ({ n: p.n, proposalId: p.proposalId, proposedByMe: p.proposedByMe })),
      previous: previous ? { n: previous.n, proposalId: previous.proposalId, proposedByMe: previous.proposedByMe, titleWas: previous.title === summary.title ? null : previous.title } : null,
      diff,
      evidence: node.evidence(threadId, proposalId),
    };
  };

  const frontDesk = (): ViewerFrontDesk => ({
    desks: desk.desks().map((d) => ({
      contact: d.contact, enabled: d.enabled, owner: d.owner, slotsPerThread: d.slotsPerThread, slotsPerDay: d.slotsPerDay,
      files: readBundle(node.home, d.contact).files.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.text), sha256: f.sha256 })),
    })),
    runs: desk.runs(100),
  });

  // The file is looked up in the bundle's own listing, never opened by the
  // name in the request.
  const bundleFile = (contact: string, name: string): ViewerBundleFile | null => {
    if (!node.contacts().some((c) => c.name === contact)) return null;
    const f = readBundle(node.home, contact).files.find((x) => x.name === name);
    return f ? { contact, name: f.name, bytes: Buffer.byteLength(f.text), sha256: f.sha256, text: f.text } : null;
  };

  const plain = (res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { ...HEADERS, ...extra, "Content-Type": "text/plain; charset=utf-8" }).end(`${message}\n`);
  };

  const json = (req: IncomingMessage, res: ServerResponse, data: unknown): void => {
    const body = JSON.stringify(data);
    const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ...HEADERS, ETag: etag }).end();
      return;
    }
    res.writeHead(200, { ...HEADERS, ETag: etag, "Content-Type": "application/json; charset=utf-8" }).end(body);
  };

  const find = (path: string): unknown => {
    if (path === "/api/overview") return overview();
    if (path === "/api/frontdesk") return frontDesk();
    let m = ROUTES.thread.exec(path);
    if (m) return thread(m[1]!);
    m = ROUTES.contract.exec(path);
    if (m) return contract(m[1]!, m[2]!);
    m = ROUTES.bundleFile.exec(path);
    if (m) return bundleFile(m[1]!, m[2]!);
    return null;
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // A page on another site can point a name it controls at 127.0.0.1. The
    // browser then sends that name here, so anything but our own address is refused.
    if (!hosts.has(req.headers.host ?? "")) return plain(res, 403, "This viewer answers only to its own local address.");
    if (req.method !== "GET") return plain(res, 405, "The viewer is read only.", { Allow: "GET" });
    const path = new URL(req.url ?? "/", "http://local").pathname;

    const file = FILES[path];
    if (file) {
      res.writeHead(200, { ...HEADERS, "Content-Type": file.type }).end(readFileSync(new URL(file.file, PUBLIC)));
      return;
    }
    if (!path.startsWith("/api/")) return plain(res, 404, "Not found.");

    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    if ((site !== undefined && site !== "same-origin") || (origin !== undefined && !hosts.has(origin.replace(/^http:\/\//, "")))) return plain(res, 403, "The viewer does not answer other pages.");
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), wanted)) return plain(res, 401, "Open the link that cpart printed. It carries the key for this page.");

    const found = find(path);
    if (found) return json(req, res, found);
    plain(res, 404, "Not found.");
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (res.headersSent) res.destroy();
      else plain(res, 500, "The viewer could not read the local data.");
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    desk.close();
    throw e;
  }
  const { port } = server.address() as AddressInfo;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  return {
    // The token rides in the fragment, which browsers never send to a server
    // or put in a Referer header. The page moves it into a request header.
    url: `http://${host === "::1" ? "[::1]" : host}:${port}/#token=${token}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => {
          desk.close();
          if (e) reject(e);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
