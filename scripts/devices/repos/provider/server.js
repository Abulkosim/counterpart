// stockroom: the warehouse stock API. See README.md.
import { createServer } from "node:http";

const KEYS = new Set(["dev-key-1"]);
const MAX_PAGE = 200;
const items = Array.from({ length: 420 }, (_, i) => ({ sku: `A-${String(100 + i)}`, name: `Part ${i}`, on_hand: (i * 37) % 500 }));
const hits = new Map();

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const error = (res, status, code, message, headers) => send(res, status, { error: { code, message } }, headers);

createServer((req, res) => {
  const key = req.headers["x-api-key"];
  if (!KEYS.has(key)) return error(res, 401, "unauthorized", "send X-Api-Key");
  const minute = Math.floor(Date.now() / 60_000);
  const n = (hits.get(`${key}:${minute}`) ?? 0) + 1;
  hits.set(`${key}:${minute}`, n);
  if (n > 600) return error(res, 429, "rate_limited", "600 requests a minute", { "retry-after": String(60 - (Math.floor(Date.now() / 1000) % 60)) });

  const url = new URL(req.url, "http://localhost");
  const one = /^\/v1\/items\/([A-Z0-9-]+)$/.exec(url.pathname);
  if (one) {
    const item = items.find((x) => x.sku === one[1]);
    return item ? send(res, 200, item) : error(res, 404, "item_not_found", "no item with that SKU");
  }
  if (url.pathname !== "/v1/items") return error(res, 404, "not_found", "no such path");
  const size = Number(url.searchParams.get("page_size") ?? 50);
  if (!Number.isInteger(size) || size < 1) return error(res, 400, "bad_page_size", "page_size is 1 to 200");
  if (size > MAX_PAGE) return error(res, 400, "page_size_too_large", "page_size is at most 200");
  const after = url.searchParams.get("cursor");
  const start = after ? items.findIndex((x) => x.sku === after) + 1 : 0;
  const page = items.slice(start, start + size);
  const last = start + size >= items.length;
  send(res, 200, { items: page, next_cursor: last || !page.length ? null : page.at(-1).sku });
}).listen(8080);
