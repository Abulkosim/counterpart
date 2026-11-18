# stockroom

A small HTTP API for the warehouse's stock. Run it with `node server.js`; it listens on port 8080.

Every request needs the header `X-Api-Key`. A missing or unknown key gets `401 {"error":{"code":"unauthorized"}}`.

## GET /v1/items

Lists items, ordered by SKU.

- `page_size`: 1 to 200, default 50. Anything above 200 is refused with `400 {"error":{"code":"page_size_too_large"}}`. It is not clamped.
- `cursor`: the `next_cursor` from the previous page. Cursors expire after 15 minutes.

The answer is always `200`:

```json
{ "items": [{ "sku": "A-100", "name": "Bolt M6", "on_hand": 140 }], "next_cursor": "A-100" }
```

On the last page `next_cursor` is `null`. It is never missing. When there are no items at all the answer is `{"items": [], "next_cursor": null}`, not a 404.

## GET /v1/items/:sku

One item, or `404 {"error":{"code":"item_not_found","message":"no item with that SKU"}}`.

## Limits

600 requests a minute per API key. Past that you get `429` with a `Retry-After` header in seconds. Wait that long; retrying sooner extends the wait.

## Errors

Every error has the shape `{"error":{"code":"...","message":"..."}}`. The codes are stable; the messages are not.
