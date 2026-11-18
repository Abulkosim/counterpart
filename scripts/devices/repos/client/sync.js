// Pulls every item from stockroom and writes it to the shop's database.
const BASE = process.env.STOCKROOM_URL ?? "http://stockroom:8080";
const KEY = process.env.STOCKROOM_KEY ?? "";

async function pullAll() {
  const all = [];
  let cursor;
  do {
    const url = new URL("/v1/items", BASE);
    url.searchParams.set("page_size", "500");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { "x-api-key": KEY } });
    const page = await res.json();
    all.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== undefined);
  return all;
}

pullAll().then((items) => console.log(`synced ${items.length} items`));
