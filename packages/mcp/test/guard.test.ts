import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Counterpart } from "@counterpart/daemon";
import { INSTRUCTIONS, createMcpServer } from "../src/index.ts";

const dirs: string[] = [];
const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const TOKEN = "Zt4mQ9vL2xR8pW1nK6sB3yH7cD5f";

async function person(env: Record<string, string>): Promise<Counterpart> {
  const home = mkdtempSync(join(tmpdir(), "cpart-mcp-guard-"));
  dirs.push(home);
  return Counterpart.init(home, { relay: "ws://127.0.0.1:9", guard: { env, cwd: null } });
}
async function carry(from: Counterpart, to: Counterpart): Promise<void> {
  for (const w of from.queued()) {
    if (w.header.to !== to.me.device) continue;
    await to.receive(w);
    from.markOutbox(w.header.id, "stored");
  }
}
async function session(node: Counterpart): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(node, { deliveryWaitMs: 50, pollMs: 10 }).connect(b);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(a);
  clients.push(client);
  return client;
}
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await c.callTool({ name: `counterpart_${name}`, arguments: args });
  return { text: (r.content as { text: string }[])[0]!.text, isError: r.isError === true };
}

test("a held message is reported as held, with the category and never the value", async () => {
  const alice = await person({ ORDERS_SERVICE_TOKEN: TOKEN });
  const bob = await person({});
  await bob.acceptInvite(alice.createInvite("bob"), "alice");
  await carry(bob, alice);
  await carry(alice, bob);
  const c = await session(alice);
  const opened = await call(c, "open_thread", { contact: "bob", goal: "orders pagination" });
  const thread = /Opened thread ([A-Za-z0-9_-]+)/.exec(opened.text)![1]!;

  for (const text of [`Here it is: ${TOKEN}`, Buffer.from(TOKEN).toString("base64")]) {
    const r = await call(c, "say", { thread, text });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Not sent: held for your human, reason: env-secret\. Nothing left this machine\./);
    assert.ok(!r.text.includes(TOKEN) && !r.text.includes(TOKEN.slice(0, 6)), "the value is never echoed");
  }
  const goal = await call(c, "open_thread", { contact: "bob", goal: `key ${TOKEN}` });
  assert.match(goal.text, /^Not sent: held for your human, reason: env-secret/);
  const proposal = await call(c, "propose_contract", { thread, title: "Sync", text: `Use token ${TOKEN} for the sync job.` });
  assert.match(proposal.text, /^Not sent: held for your human, reason: env-secret/);

  assert.equal(alice.guard.counts().held, 4);
  await carry(alice, bob);
  assert.equal(bob.log(thread).filter((e) => e.type === "talk.posted").length, 0);
  // The read tools show nothing of it: held messages are not in the log.
  const read = await call(c, "read_thread", { thread });
  assert.ok(!read.text.includes(TOKEN));
  const ok = await call(c, "say", { thread, text: "Page size 200, cursor opaque." });
  assert.equal(ok.isError, false);
});

test("the instructions tell the agent not to work around a hold", () => {
  assert.match(INSTRUCTIONS, /held for your human/);
  assert.match(INSTRUCTIONS, /Do not reword, encode or split it/);
});
