import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import {
  type DeviceSecrets, type ServerFrame, type ThreadEvent, type Wire, RELAY_AUTH_DOMAIN, deviceId, generateSigningKey, issueDevice,
  randomId, relayAuthMessage, seal, sign,
} from "@counterpart/protocol";
import { type Relay, startRelay } from "../src/index.ts";

let relay: Relay;
const sockets: WebSocket[] = [];
before(async () => {
  relay = await startRelay({ maxPerSender: 3 });
});
after(async () => {
  for (const s of sockets) s.terminate();
  await relay.close();
});

interface Client {
  ws: WebSocket;
  next(t?: string): Promise<ServerFrame>;
  closed: Promise<number>;
}
function dial(url = relay.url): Client {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const frames: ServerFrame[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (raw) => {
    frames.push(JSON.parse(raw.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  return {
    ws,
    closed,
    async next(t) {
      const end = Date.now() + 3000;
      for (;;) {
        const i = frames.findIndex((f) => !t || f.t === t);
        if (i >= 0) return frames.splice(i, 1)[0]!;
        if (Date.now() > end) throw new Error(`no ${t ?? "frame"} from relay`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
  };
}
async function login(d: DeviceSecrets, url = relay.url): Promise<Client> {
  const c = dial(url);
  const ch = (await c.next("challenge")) as { nonce: string };
  c.ws.send(JSON.stringify({ t: "auth", credential: d.credential, relay: url, sig: sign(d.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(ch.nonce, url)) }));
  await c.next("ready");
  return c;
}
const device = () => issueDevice(generateSigningKey());
function wireFor(from: DeviceSecrets, to: DeviceSecrets, ttl = 3600_000, id = randomId()): Promise<Wire> {
  const event: ThreadEvent = { id, threadId: randomId(), author: deviceId(from.credential), authorSeq: 0, parents: [], lane: "talk", type: "talk.posted", body: { text: "x" }, createdAt: Date.now() };
  return seal(event, from, to.credential, Date.now() + ttl);
}

test("stores for an offline device and delivers on connect; ack removes it", async () => {
  const [a, b] = [await device(), await device()];
  const ca = await login(a);
  const wire = await wireFor(a, b);
  ca.ws.send(JSON.stringify({ t: "send", wire }));
  assert.deepEqual(await ca.next("stored"), { t: "stored", id: wire.header.id });
  assert.equal(relay.queued(deviceId(b.credential)), 1);
  const cb = await login(b);
  assert.deepEqual(((await cb.next("deliver")) as { wire: Wire }).wire, wire);
  cb.ws.send(JSON.stringify({ t: "ack", id: wire.header.id }));
  for (let i = 0; i < 100 && relay.queued(deviceId(b.credential)) > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(relay.queued(deviceId(b.credential)), 0);
});

test("a device cannot acknowledge away someone else's mail", async () => {
  const [a, b, c] = [await device(), await device(), await device()];
  const ca = await login(a);
  const wire = await wireFor(a, b);
  ca.ws.send(JSON.stringify({ t: "send", wire }));
  await ca.next("stored");
  const cc = await login(c);
  cc.ws.send(JSON.stringify({ t: "ack", id: wire.header.id }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(relay.queued(deviceId(b.credential)), 1);
});

test("rejects a login signed with the wrong key or for another relay", async () => {
  const [a, b] = [await device(), await device()];
  const c1 = dial();
  const ch1 = (await c1.next("challenge")) as { nonce: string };
  c1.ws.send(JSON.stringify({ t: "auth", credential: a.credential, relay: relay.url, sig: sign(b.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(ch1.nonce, relay.url)) }));
  assert.equal(await c1.closed, 4003);

  const c2 = dial();
  const ch2 = (await c2.next("challenge")) as { nonce: string };
  c2.ws.send(JSON.stringify({ t: "auth", credential: a.credential, relay: relay.url, sig: sign(a.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(ch2.nonce, "ws://evil.example")) }));
  assert.equal(await c2.closed, 4003);

  const c3 = dial();
  await c3.next("challenge");
  c3.ws.send(JSON.stringify({ t: "send", wire: await wireFor(a, b) }));
  assert.equal(await c3.closed, 4003);
});

test("retrying the same message is accepted; reusing its id for other bytes is not", async () => {
  const [a, b] = [await device(), await device()];
  const ca = await login(a);
  const wire = await wireFor(a, b);
  ca.ws.send(JSON.stringify({ t: "send", wire }));
  await ca.next("stored");
  ca.ws.send(JSON.stringify({ t: "send", wire }));
  await ca.next("stored");
  assert.equal(relay.queued(deviceId(b.credential)), 1);
  ca.ws.send(JSON.stringify({ t: "send", wire: await wireFor(a, b, 3600_000, wire.header.id) }));
  assert.deepEqual(await ca.next("error"), { t: "error", code: "conflict", id: wire.header.id });
});

test("limits how much one sender can queue for one recipient, and refuses bad expiry", async () => {
  const [a, b] = [await device(), await device()];
  const ca = await login(a);
  for (let i = 0; i < 3; i++) {
    ca.ws.send(JSON.stringify({ t: "send", wire: await wireFor(a, b) }));
    await ca.next("stored");
  }
  ca.ws.send(JSON.stringify({ t: "send", wire: await wireFor(a, b) }));
  assert.equal(((await ca.next("error")) as { code: string }).code, "mailbox_full");
  ca.ws.send(JSON.stringify({ t: "send", wire: await wireFor(a, b, 30 * 24 * 3600_000) }));
  assert.equal(((await ca.next("error")) as { code: string }).code, "ttl_too_long");
  ca.ws.send(JSON.stringify({ t: "send", wire: { header: {}, enc: "", ct: "" } }));
  assert.equal(((await ca.next("error")) as { code: string }).code, "bad_wire");
});

test("an invite-only relay turns away other root keys", async () => {
  const root = generateSigningKey();
  const closed = await startRelay({ allowRoots: [root.publicKey] });
  try {
    await login(await issueDevice(root), closed.url);
    const outsider = await device();
    const c = dial(closed.url);
    const ch = (await c.next("challenge")) as { nonce: string };
    c.ws.send(JSON.stringify({ t: "auth", credential: outsider.credential, relay: closed.url, sig: sign(outsider.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(ch.nonce, closed.url)) }));
    assert.equal(await c.closed, 4003);
  } finally {
    await closed.close();
  }
});

test("a login signed for a different relay URL is refused, with a reason", async () => {
  const a = await device();
  const evil = "ws://evil.example";
  const c = dial();
  const ch = (await c.next("challenge")) as { nonce: string };
  // What a forwarding relay would pass on: a valid signature over its own URL.
  c.ws.send(JSON.stringify({ t: "auth", credential: a.credential, relay: evil, sig: sign(a.sign, RELAY_AUTH_DOMAIN, relayAuthMessage(ch.nonce, evil)) }));
  assert.deepEqual(await c.next("error"), { t: "error", code: "wrong_relay_url" });
  assert.equal(await c.closed, 4003);
});

test("a long backlog is delivered a window at a time and one sender cannot fill the relay", async () => {
  const small = await startRelay({ deliveryWindow: 2, maxPerSenderTotal: 5 });
  try {
    const [a, b] = [await device(), await device()];
    const ca = await login(a, small.url);
    for (let i = 0; i < 5; i++) {
      ca.ws.send(JSON.stringify({ t: "send", wire: await wireFor(a, b) }));
      await ca.next("stored");
    }
    // Spraying other recipients does not get around the limit.
    ca.ws.send(JSON.stringify({ t: "send", wire: await wireFor(a, await device()) }));
    assert.equal(((await ca.next("error")) as { code: string }).code, "mailbox_full");

    const cb = await login(b, small.url);
    const got: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = ((await cb.next("deliver")) as { wire: Wire }).wire.header.id;
      got.push(id);
      if (i === 1) {
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(small.queued(deviceId(b.credential)), 5, "nothing beyond the window is sent before acks");
        for (const g of got) cb.ws.send(JSON.stringify({ t: "ack", id: g }));
      } else if (i > 1) cb.ws.send(JSON.stringify({ t: "ack", id }));
    }
    assert.equal(new Set(got).size, 5);
  } finally {
    await small.close();
  }
});

test("a port that is already taken is a plain error, not a crash", async () => {
  await assert.rejects(startRelay({ port: relay.port }), /already in use/);
  // The first relay is untouched.
  assert.equal(((await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).json()) as { ok: boolean }).ok, true);
});
