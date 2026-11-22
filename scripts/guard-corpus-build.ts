// Builds packages/daemon/test/guard-corpus/ordinary.json: messages of the kind
// two developers' agents send each other, none of which may be held.
//
//   node scripts/guard-corpus-build.ts [model-batch.json ...]
//
// Three sources, each tagged:
//   templated  made here from templates with a fixed seed: ids, hashes, digests,
//              base64 of plain data, URLs, stack traces, JSON, config with placeholders
//   docs       paragraphs of this repository's own docs, as they were when built
//   model      written by claude-sonnet-5-5 when asked for ordinary agent-to-agent
//              messages with no secrets (the prompt is in docs/guard.md); passed as files
// Deterministic for the first two. Run it again only to change the corpus on purpose.
// Needs node 24 only. It calls no model: the model batches are files you pass in.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "packages/daemon/test/guard-corpus/ordinary.json");

let seed = 0x5eed1234;
const rand = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number): number => a + Math.floor(rand() * (b - a + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chars = (alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
const hex = (n: number): string => chars("0123456789abcdef", n);
const b62 = (n: number): string => chars("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", n);
const uuid = (): string => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
const ulid = (): string => chars("0123456789ABCDEFGHJKMNPQRSTVWXYZ", 26);
const iso = (): string => new Date(Date.UTC(2026, int(0, 10), int(1, 28), int(0, 23), int(0, 59), int(0, 59), int(0, 999))).toISOString();
const b64 = (s: string | Buffer): string => Buffer.from(s).toString("base64");
const b64url = (s: string | Buffer): string => Buffer.from(s).toString("base64url");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const words = ["orders", "invoices", "customers", "shipments", "payments", "users", "projects", "reports", "events", "products", "carts", "refunds"];
const services = ["orders-api", "billing", "gateway", "web-client", "ledger", "search", "notifier", "auth-service", "inventory"];
const people = ["alice", "bob", "maya", "sam", "lee", "ana"];
const repo = (): string => `${pick(["acme", "northwind", "contoso", "initech"])}/${pick(services)}`;
const file = (): string => pick(["src/orders/handler.ts", "src/api/pagination.go", "app/models/invoice.py", "lib/client.rb", "internal/store/pg.go", "src/main/java/com/acme/OrderController.java", "packages/web/src/hooks/useOrders.ts", "server/routes/refunds.js"]);
const status = (): number => pick([200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503]);

const T: (() => string)[] = [
  () => `GET /v${int(1, 3)}/${pick(words)}?limit=${pick([20, 50, 100, 200])}&cursor=${b64url(JSON.stringify({ id: int(1000, 99999), ts: iso() }))} returns ${status()} for me. Is the cursor opaque on your side, or do you parse it?`,
  () => `Here is what we return for an empty page:\n\n{\n  "items": [],\n  "next_cursor": null,\n  "total": 0,\n  "request_id": "${uuid()}"\n}\n\nSo next_cursor is null, not an empty string.`,
  () => `Pushed ${hex(40)} to ${pick(["main", "fix/pagination", "feat/refunds-v2", "chore/deps"])}. CI is at https://github.com/${repo()}/actions/runs/${int(1e9, 9e9)}.`,
  () => `The schema file I am binding is page.schema.json, sha256 ${sha256(String(rand()))}. Can you confirm yours matches?`,
  () => `Trace id ${hex(32)}, span ${hex(16)}. The ${pick(services)} call took ${int(80, 4000)} ms and then we got a ${status()}.`,
  () => `Request ${uuid()} failed:\n\nError: connect ECONNREFUSED 127.0.0.1:${int(3000, 9999)}\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:${int(1000, 2000)}:${int(1, 30)})\n    at ${pick(["fetchOrders", "loadPage", "syncInvoices"])} (/srv/app/${file()}:${int(10, 400)}:${int(3, 40)})`,
  () => `Traceback (most recent call last):\n  File "/app/${pick(["worker", "api", "jobs"])}/tasks.py", line ${int(10, 300)}, in run\n    result = client.list_${pick(words)}(page_size=${int(10, 500)})\n  File "/usr/lib/python3.12/site-packages/httpx/_client.py", line ${int(800, 1700)}, in request\n    raise HTTPStatusError(message, request=request, response=self)\nhttpx.HTTPStatusError: Client error '${status()} ' for url 'https://api.example.com/v2/${pick(words)}'`,
  () => `panic: runtime error: index out of range [${int(1, 9)}] with length ${int(0, 1)}\n\ngoroutine ${int(1, 400)} [running]:\nmain.(*Pager).Next(0xc000${hex(6)})\n\t/go/src/${repo()}/${pick(["pager.go", "store.go"])}:${int(20, 300)} +0x${hex(3)}`,
  () => `java.lang.IllegalStateException: cursor expired\n\tat com.acme.orders.Pager.next(Pager.java:${int(10, 200)})\n\tat com.acme.orders.OrderController.list(OrderController.java:${int(10, 200)})\n\tat jdk.internal.reflect.GeneratedMethodAccessor${int(1, 90)}.invoke(Unknown Source)`,
  () => `Image is ghcr.io/${repo()}@sha256:${hex(64)}. Pin to that digest rather than :latest.`,
  () => `From the lockfile: "integrity": "sha512-${b64(Buffer.from(hex(128), "hex"))}"`,
  () => `curl -s -H "Authorization: Bearer $TOKEN" "https://api.example.com/v1/${pick(words)}/${uuid()}" | jq .status`,
  () => `To call it: curl -H 'X-Api-Key: <your-api-key>' https://sandbox.example.org/v${int(1, 3)}/${pick(words)}. Use your own sandbox key; I am not sending mine.`,
  () => `In CI we read it as \${{ secrets.${pick(["NPM_TOKEN", "DEPLOY_KEY", "PYPI_API_TOKEN", "SLACK_WEBHOOK_URL"])} }}. Nothing secret is in the repo.`,
  () => `.env.example on our side:\n\nDATABASE_URL=postgres://user:password@localhost:5432/${pick(words)}\nAPI_KEY=your-key-here\nSESSION_SECRET=changeme\nPORT=${int(3000, 9000)}\nLOG_LEVEL=debug`,
  () => `Auth works like this: the client gets an access token from /oauth/token, sends it as a bearer token, and refreshes it with the refresh token when it gets a 401. The token is a JWT, but we never look inside it on the client.`,
  () => `We moved the password hashing to argon2id with m=${pick([19456, 65536])}, t=${int(2, 4)}, p=1. Old bcrypt hashes are rehashed at next login.`,
  () => `Session cookies are HttpOnly, Secure and SameSite=Lax. The session id is ${int(16, 32)} random bytes and is never logged.`,
  () => `Rate limit is ${int(60, 1200)} requests a minute per key. On a 429 we send Retry-After: ${int(1, 60)}.`,
  () => `Migration:\n\nALTER TABLE ${pick(words)} ADD COLUMN cursor_id BIGINT;\nCREATE INDEX CONCURRENTLY ${pick(words)}_cursor_idx ON ${pick(words)} (created_at, id);`,
  () => `openapi: 3.1.0\npaths:\n  /${pick(words)}:\n    get:\n      parameters:\n        - name: limit\n          in: query\n          schema: { type: integer, minimum: 1, maximum: ${pick([100, 200, 500])} }\n      responses:\n        "200": { description: A page }`,
  () => `message Page {\n  repeated Order items = 1;\n  string next_cursor = 2;\n  int32 total = 3;\n}`,
  () => `The page token is just base64 of JSON: ${b64(JSON.stringify({ after: int(1, 1e6), dir: pick(["asc", "desc"]) }))}. Decode it and you will see the id.`,
  () => `Small PNG we use as the placeholder: data:image/png;base64,${b64(Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from(hex(26), "hex")]))}`,
  () => `diff --git a/${file()} b/${file()}\nindex ${hex(7)}..${hex(7)} 100644\n--- a/${file()}\n+++ b/${file()}\n@@ -${int(1, 90)},${int(3, 9)} +${int(1, 90)},${int(3, 9)} @@\n-  const limit = Math.min(req.query.limit ?? 50, 100);\n+  const limit = Math.min(Number(req.query.limit ?? 50), 200);`,
  () => `Customer cus_${b62(14)} has invoices in_${b62(24)} and in_${b62(24)}. Both show status=paid on our side.`,
  () => `Order ${ulid()} was created at ${iso()} and shipped at ${iso()}.`,
  () => `ETag: "${hex(32)}". Send it back in If-None-Match and you will get a 304.`,
  () => `md5 of the export is ${hex(32)} and sha1 is ${hex(40)}. Same as yesterday.`,
  () => `Can you rerun CI on ${pick(["#", "PR #"])}${int(10, 999)}? The flaky test is ${pick(["test_pagination_last_page", "OrdersPager handles empty page", "TestRefundIdempotency"])}.`,
  () => pick(["Pushed the fix.", "Looks good to me. Merging after CI.", "I will update the client today.", "Agreed: limit 200, cursor opaque, empty page returns items: [].", "Thanks, that answers it.", "One more question on errors below."]),
  () => `Error body we send:\n\n{"error": {"code": "${pick(["invalid_cursor", "rate_limited", "not_found", "conflict"])}", "message": "${pick(["The cursor has expired.", "Too many requests.", "No such order.", "Version mismatch."])}", "request_id": "req_${b62(20)}"}}`,
  () => `Our webhook signs payloads with HMAC-SHA256 in the X-Signature header: t=${int(1.7e9, 1.8e9)},v1=${hex(64)}. Verify with your own signing secret from the dashboard.`,
  () => `Log line: ${iso()} level=info msg="page served" route=/v1/${pick(words)} limit=${int(10, 200)} took_ms=${int(1, 900)} trace_id=${hex(32)} user_id=${int(1, 99999)}`,
  () => `Dockerfile step: RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci. The secret is passed at build time, not baked in.`,
  () => `Kubernetes: the pod reads DB_PASSWORD from a Secret named ${pick(services)}-db via secretKeyRef. Rotation happens in vault, not in the manifest.`,
  () => `version = "${int(0, 3)}.${int(0, 20)}.${int(0, 40)}"\n[dependencies]\nserde = { version = "1", features = ["derive"] }\nreqwest = "0.12"`,
  () => `The ${pick(services)} release ${int(1, 9)}.${int(0, 30)}.${int(0, 40)} is tagged at ${hex(40)}; changelog at https://github.com/${repo()}/releases/tag/v${int(1, 9)}.${int(0, 30)}.${int(0, 9)}`,
  () => `We store an API key as sha256(key) only, so we can look it up without keeping it. Prefix shown in the dashboard is the first 6 characters, like ak_live_****.`,
  () => `SSH host key fingerprint for the deploy box: SHA256:${b64(Buffer.from(hex(64), "hex")).replace(/=+$/, "")}. Compare it before you accept.`,
  () => `GPG key id ${hex(16).toUpperCase()} signed the tag. Fingerprint ${hex(40).toUpperCase().replace(/(.{4})/g, "$1 ").trim()}.`,
  () => `${pick(people)} asked whether ${pick(words)} ids are stable across regions. They are: ids are UUIDv7, e.g. 01${hex(6)}-${hex(4)}-7${hex(3)}-${pick(["8", "9", "a"])}${hex(3)}-${hex(12)}.`,
  () => `Feature flag ${pick(["new_pager", "refunds_v2", "strict_cursor"])} is on for ${int(1, 100)}% of tenants. Tenant ids: ${Array.from({ length: int(2, 5) }, () => `t_${b62(10)}`).join(", ")}.`,
  () => `GraphQL:\n\nquery { ${pick(words)}(first: ${int(10, 100)}, after: "${b64(`cursor:${int(1, 9999)}`)}") { edges { node { id } } pageInfo { hasNextPage endCursor } } }`,
  () => `pnpm-lock says ${pick(["zod", "ws", "undici", "express"])}@${int(1, 9)}.${int(0, 30)}.${int(0, 20)} with tarball https://registry.npmjs.org/${pick(["zod", "ws", "undici"])}/-/${pick(["zod", "ws", "undici"])}-${int(1, 9)}.${int(0, 30)}.${int(0, 20)}.tgz`,
  () => `If the key is missing the server answers 401 with WWW-Authenticate: Bearer realm="api", error="invalid_token". That is expected in the test.`,
  () => `Postgres for local runs: docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16. Connect with postgres://postgres:postgres@localhost:5432/postgres.`,
  () => `Here is the fixture:\n\n${JSON.stringify({ id: uuid(), created_at: iso(), amount: int(100, 99999), currency: pick(["usd", "eur", "uzs"]), customer: `cus_${b62(14)}`, metadata: { order: ulid() } }, null, 2)}`,
  () => `Benchmarks on ${hex(7)}: p50 ${int(2, 30)} ms, p99 ${int(40, 400)} ms at ${int(100, 2000)} rps. Before the index it was p99 ${int(500, 3000)} ms.`,
  () => `The JWT has three parts: header, payload, signature. We only read the sub and exp claims after verifying with the JWKS at https://auth.example.com/.well-known/jwks.json, kid ${hex(8)}.`,
];

function templated(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(T[i % T.length]!());
  return out;
}

// Paragraphs of the repo's own docs: real technical prose about keys, hashes and approvals.
function docs(): string[] {
  const files = ["README.md", "SECURITY.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md") && f !== "gauntlet.md").map((f) => `docs/${f}`)];
  const out: string[] = [];
  for (const f of files) {
    for (const p of readFileSync(join(ROOT, f), "utf8").split(/\n\s*\n/)) {
      const t = p.trim();
      if (t.length >= 80 && t.length <= 4000) out.push(t);
    }
  }
  return out;
}

function model(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const raw = readFileSync(f, "utf8").trim().replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) throw new Error(`${f}: not a JSON array`);
    for (const m of list) if (typeof m === "string" && m.trim()) out.push(m);
  }
  return out;
}

const existing = (() => {
  try {
    return JSON.parse(readFileSync(OUT, "utf8")) as { messages: { source: string; text: string }[] };
  } catch {
    return { messages: [] };
  }
})();
const modelBatches = process.argv.slice(2);
const modelMessages = modelBatches.length ? model(modelBatches) : existing.messages.filter((m) => m.source === "model").map((m) => m.text);
const messages = [
  ...templated(400).map((text) => ({ source: "templated", text })),
  ...docs().map((text) => ({ source: "docs", text })),
  ...modelMessages.map((text) => ({ source: "model", text })),
];
writeFileSync(
  OUT,
  `${JSON.stringify({ note: "Ordinary agent-to-agent messages. None may be held. Built by scripts/guard-corpus-build.ts; see docs/guard.md.", messages }, null, 1)}\n`,
);
console.log(`wrote ${messages.length} messages: ${["templated", "docs", "model"].map((s) => `${s} ${messages.filter((m) => m.source === s).length}`).join(", ")}`);
