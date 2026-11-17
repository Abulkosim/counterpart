import { after, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { type DeviceSecrets, type PairServerFrame, RELAY_AUTH_DOMAIN, generateSigningKey, issueDevice, relayAuthMessage, sign } from "@counterpart/protocol";
import { type Relay, type RelayOptions, startRelay } from "../src/index.ts";

const open: { relays: Relay[]; sockets: WebSocket[] } = { relays: [], sockets: [] };
after(async () => {
  for (const s of open.sockets) s.terminate();
  for (const r of open.relays) await r.close();
});

async function relay(opts: RelayOptions = {}): Promise<Relay> {
  const r = await startRelay(opts);
  open.relays.push(r);
  return r;
}

interface Client {
  send(f: unknown): void;
  next(t: string, ms?: number): Promise<PairServerFrame & Record<string, unknown>>;
  none(t: string, ms?: number): Promise<void>;
  ws: WebSocket;
}
async function login(r: Relay, d?: DeviceSecrets): Promise<Client> {
  const dev = d ?? (await issueDevice(generateSigningKey()));
  const ws = new WebSocket(r.url);
  open.sockets.push(ws);
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  const take = async (t: string, ms = 2000): Promise<Record<string, unknown> | undefined> => {
    const end = Date.now() + ms;
    for (;;) {
      const i = frames.findIndex((f) => f.t === t);
      if (i >= 0) return frames.splice(i, 1)[0];
      if (Date.now() > end) return undefined;
      await new Promise((res) => setTimeout(res, 10));
    }
  };
  const c: Client = {
    ws,
    send: (f) => ws.send(JSON.stringify(f)),
    async next(t, ms) {
      const f = await take(t, ms);
      if (!f) throw new Error(`no ${t}`);
      return f as never;
    },
    async none(t, ms = 200) {
      const f = await take(t, ms);
      assert.equal(f, undefined, `unexpected ${t}: ${JSON.stringify(f)}`);
    },
  };
  const ch = (await c.next("challenge")) as unknown as { nonce: string };
  c.send({ t: "auth", credential: dev.credential, relay: r.url, sig: sign(dev.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(ch.nonce, r.url)) });
  await c.next("ready");
  return c;
}

test("open, claim once, pass messages both ways, close", async () => {
  const r = await relay();
  const a = await login(r);
  const b = await login(r);
  const c = await login(r);
  a.send({ t: "pair.open", ref: "r1" });
  const opened = await a.next("pair.opened");
  assert.equal(opened.ref, "r1");
  const n = opened.nameplate as number;
  assert.ok(n >= 1 && n <= 99);
  a.send({ t: "pair.send", nameplate: n, body: "hello" });
  b.send({ t: "pair.claim", nameplate: n });
  await b.next("pair.claimed");
  assert.deepEqual(await b.next("pair.msg"), { t: "pair.msg", nameplate: n, from: "inviter", n: 0, body: "hello" });
  await a.next("pair.joined");
  // The number is taken: nobody else can claim it, and nobody else can write to it.
  c.send({ t: "pair.claim", nameplate: n });
  assert.equal((await c.next("pair.error")).code, "nameplate_taken");
  c.send({ t: "pair.send", nameplate: n, body: "x" });
  assert.equal((await c.next("pair.error")).code, "nameplate_not_yours");
  a.send({ t: "pair.claim", nameplate: n });
  assert.equal((await a.next("pair.error")).code, "nameplate_own");
  b.send({ t: "pair.send", nameplate: n, body: "back" });
  assert.equal((await a.next("pair.msg")).body, "back");
  // Sent again after a reconnect: one message, delivered once.
  b.send({ t: "pair.send", nameplate: n, body: "back" });
  await a.none("pair.msg");
  b.send({ t: "pair.close", nameplate: n });
  assert.equal((await a.next("pair.closed")).why, "closed");
  // Gone, and the number rests: it is not handed out again straight away.
  c.send({ t: "pair.claim", nameplate: n });
  assert.equal((await c.next("pair.error")).code, "nameplate_unknown");
  for (let i = 0; i < 3; i++) {
    a.send({ t: "pair.open", ref: `again${i}` });
    assert.notEqual((await a.next("pair.opened")).nameplate, n);
  }
});

test("messages wait for a side that is offline and come again on reconnect", async () => {
  const r = await relay();
  const devA = await issueDevice(generateSigningKey());
  const a = await login(r, devA);
  const b = await login(r);
  a.send({ t: "pair.open", ref: "r" });
  const n = (await a.next("pair.opened")).nameplate;
  a.send({ t: "pair.send", nameplate: n, body: "one" });
  a.ws.close();
  b.send({ t: "pair.claim", nameplate: n });
  await b.next("pair.msg");
  b.send({ t: "pair.send", nameplate: n, body: "two" });
  const a2 = await login(r, devA);
  assert.equal((await a2.next("pair.msg")).body, "two");
});

test("limits: opens and claims per device, messages per side, size, expiry", async () => {
  let t = Date.now();
  const r = await relay({ now: () => t, pairing: { opensPerHour: 3, openAtOnce: 2, claimsPerHour: 3, maxMessages: 2, ttlMs: 60_000 } });
  const a = await login(r);
  const b = await login(r);
  a.send({ t: "pair.open", ref: "1" });
  const n1 = (await a.next("pair.opened")).nameplate;
  a.send({ t: "pair.open", ref: "2" });
  await a.next("pair.opened");
  a.send({ t: "pair.open", ref: "3" });
  assert.equal((await a.next("pair.error")).code, "rate_limited", "two open at once");
  a.send({ t: "pair.send", nameplate: n1, body: "x".repeat(4097) });
  assert.equal((await a.next("pair.error")).code, "bad_frame");
  a.send({ t: "pair.send", nameplate: n1, body: "1" });
  a.send({ t: "pair.send", nameplate: n1, body: "2" });
  a.send({ t: "pair.send", nameplate: n1, body: "3" });
  assert.equal((await a.next("pair.error")).code, "too_many_messages");
  // A device that guesses numbers runs out of claims.
  for (const n of [9001, 9002, 9003]) b.send({ t: "pair.claim", nameplate: n });
  for (let i = 0; i < 3; i++) assert.equal((await b.next("pair.error")).code, "nameplate_unknown");
  b.send({ t: "pair.claim", nameplate: n1 });
  assert.equal((await b.next("pair.error")).code, "rate_limited");
  // Expiry tells the owner and frees the slot.
  t += 61_000;
  r.queued(); // any call; the sweep runs on the next frame
  a.send({ t: "pair.open", ref: "4" });
  assert.equal((await a.next("pair.closed")).why, "expired");
  assert.ok((await a.next("pair.opened")).nameplate);
  a.send({ t: "pair.open", ref: "5" });
  assert.equal((await a.next("pair.error")).code, "rate_limited", "three opens an hour");
});

test("bad frames get an error, not a crash", async () => {
  const r = await relay();
  const a = await login(r);
  for (const f of [{ t: "pair.open" }, { t: "pair.open", ref: "bad ref" }, { t: "pair.claim", nameplate: "7" }, { t: "pair.claim", nameplate: 0 }, { t: "pair.claim", nameplate: 10000 }, { t: "pair.what", nameplate: 5 }]) {
    a.send(f);
    assert.ok(["bad_frame", "nameplate_unknown"].includes((await a.next("pair.error")).code as string), JSON.stringify(f));
  }
  a.send({ t: "pair.open", ref: "ok" });
  await a.next("pair.opened");
});
