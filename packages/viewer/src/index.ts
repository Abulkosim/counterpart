import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Counterpart, StoredEvent, ThreadSummary } from "@counterpart/daemon";
import { deviceId, humanId } from "@counterpart/protocol";

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
  text: string | null;
}

export interface ViewerOverview {
  me: { human: string; device: string; relay: string; rootKey: string; home: string };
  threads: ThreadSummary[];
  contacts: { name: string; state: "pending" | "active"; safetyCode: string; human: string; device: string; relay: string; credentialExpiresAt: number }[];
  rejects: { at: number; reason: string; wireId: string | null }[];
}

export interface ViewerThread {
  thread: ThreadSummary;
  events: ViewerEvent[];
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const PUBLIC = new URL("../public/", import.meta.url);
const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

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

function textOf(e: StoredEvent): string | null {
  const body = e.body as { text?: unknown; goal?: unknown };
  if (e.type === "talk.posted" && typeof body.text === "string") return body.text;
  if (e.type === "thread.opened" && typeof body.goal === "string") return body.goal;
  return null;
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

  const overview = (): ViewerOverview => ({
    me: { human: node.me.human, device: node.me.device, relay: node.me.relay, rootKey: node.me.rootKey, home: node.home },
    threads: node.threads(),
    contacts: node.contacts().map((c) => ({
      name: c.name, state: c.state, safetyCode: c.safetyCode, human: humanId(c.rootKey), device: deviceId(c.credential),
      relay: c.relay, credentialExpiresAt: c.credential.expiresAt,
    })),
    rejects: node.rejects(200),
  });

  const thread = (id: string): ViewerThread | null => {
    const t = node.threads().find((x) => x.id === id);
    if (!t) return null;
    return {
      thread: t,
      events: node.log(id).map((e) => ({ id: e.id, type: e.type, mine: e.mine, status: e.status, createdAt: e.createdAt, receivedAt: e.receivedAt, text: textOf(e) })),
    };
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

    if (path === "/api/overview") return json(req, res, overview());
    const m = /^\/api\/threads\/([A-Za-z0-9_-]{16,64})$/.exec(path);
    const found = m ? thread(m[1]!) : null;
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  return {
    // The token rides in the fragment, which browsers never send to a server
    // or put in a Referer header. The page moves it into a request header.
    url: `http://${host === "::1" ? "[::1]" : host}:${port}/#token=${token}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
