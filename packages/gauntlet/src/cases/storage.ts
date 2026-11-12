import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Counterpart } from "@counterpart/daemon";
import { type Ctx, DAY, until } from "../harness.ts";
import type { Case } from "../types.ts";

const mode = (path: string): number => statSync(path).mode & 0o777;
const others = (path: string): number => statSync(path).mode & 0o077;

// A real exchange through a relay that keeps its mailbox in a file, with the recipient offline.
async function atRest(ctx: Ctx): Promise<{ disk: Buffer; alice: Counterpart; bob: Counterpart; thread: string; marks: string[] }> {
  const dir = ctx.dir();
  const relay = await ctx.relay({ dbPath: join(dir, "relay.db") });
  const bob = await ctx.person({ relay: relay.url });
  const alice = await ctx.contact(bob, "alice");
  ctx.connect(alice);
  const marks = ["PLAINTEXT-GOAL-7f3a", "PLAINTEXT-TALK-91c2"];
  const thread = await alice.openThread("them", marks[0]!);
  await alice.say(thread, marks[1]!);
  await until("the relay to hold both messages", () => relay.queued(bob.me.device) === 2);
  const disk = Buffer.concat(readdirSync(dir).map((f) => readFileSync(join(dir, f))));
  return { disk, alice, bob, thread, marks };
}

export const storage: Case[] = [
  {
    id: "STO-01",
    category: "storage",
    attacker: "stranger",
    title: "Read the key file as another local user",
    claim: "The key file is readable only by its owner, when first written and after every renewal.",
    async run(ctx) {
      const home = join(ctx.dir(), "fresh");
      const init = ctx.cli(home, ["init", "--relay", "ws://127.0.0.1:9", "--no-passphrase"], { umask: "000" });
      assert.equal(init.status, 0, init.stderr.toString());
      assert.equal(mode(home), 0o700);
      assert.equal(mode(join(home, "keys.json")), 0o600);

      const later = Counterpart.open(home, { now: () => Date.now() + 70 * DAY });
      try {
        assert.equal(await later.renewIfDue(), true);
      } finally {
        later.close();
      }
      assert.equal(mode(join(home, "keys.json")), 0o600);
      assert.deepEqual(readdirSync(home).filter((f) => f.endsWith(".tmp")), []);
    },
  },
  {
    id: "STO-02",
    category: "storage",
    attacker: "stranger",
    title: "Read the message log as another local user",
    claim: "Nothing in the identity directory is readable by other users, whatever the directory's own permissions were.",
    async run(ctx) {
      const home = join(ctx.dir(), "existing");
      mkdirSync(home);
      chmodSync(home, 0o755);
      const init = ctx.cli(home, ["init", "--relay", "ws://127.0.0.1:9", "--no-passphrase"], { umask: "022" });
      assert.equal(init.status, 0, init.stderr.toString());
      assert.equal(ctx.cli(home, ["invite", "carol"], { umask: "022" }).status, 0);
      assert.equal(others(join(home, "keys.json")), 0);
      const exposed = readdirSync(home).filter((f) => others(join(home, f)) !== 0);
      assert.ok(others(home) === 0 || exposed.length === 0, `readable by other users: ${exposed.join(", ")}`);
    },
  },
  {
    id: "STO-03",
    category: "storage",
    attacker: "relay",
    title: "Search the relay's disk for message content",
    claim: "The relay's database holds no plaintext: no message text, goal, thread id or root key.",
    async run(ctx) {
      const { disk, alice, bob, thread, marks } = await atRest(ctx);
      assert.ok(disk.includes(bob.me.device), "test bug: the mailbox is not in these files");
      const secrets = [...marks, thread, alice.me.rootKey, bob.me.rootKey, alice.device.credential.signKey, alice.device.credential.sig];
      for (const s of secrets) {
        assert.equal(disk.includes(s), false, `found ${s}`);
        assert.equal(disk.includes(Buffer.from(s, "utf16le")), false, `found ${s} as UTF-16`);
      }
    },
  },
  {
    id: "STO-04",
    category: "storage",
    attacker: "relay",
    title: "Read who writes to whom from the relay's disk",
    claim: "The relay stores who a message is for and when it expires, and nothing else about it.",
    knownFailure: "each queued message is stored with its sender's device id",
    finding: {
      severity: "low",
      where: "packages/relay/src/index.ts:68",
      scenario:
        "Someone who obtains the relay's database (a backup, a seized disk, a curious operator) reads the from_device and to_device columns and learns which devices were writing to which while messages were queued. " +
        "docs/design.md says the relay sees who a message is for and when it expires, and nothing else. The relay has to know the sender while it is connected, but nothing requires writing it down in the clear.",
      fix: "Store a keyed hash of the sender (key held in memory, new on each start) for the quota counts, or say in the docs that the relay records sender and recipient for queued mail.",
    },
    async run(ctx) {
      const { disk, alice, bob } = await atRest(ctx);
      assert.ok(disk.includes(bob.me.device), "test bug: the mailbox is not in these files");
      assert.equal(disk.includes(alice.me.device), false, "the sender's device id is on the relay's disk next to the recipient's");
    },
  },
];
