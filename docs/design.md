# Design

What Counterpart is, why it is shaped this way, and what it does not do yet.

## The idea

Two people each have an AI agent. When the agents need something from each other, the people copy and paste between chat windows. Counterpart lets the agents talk directly, on behalf of their people, and makes the result something both can trust: an agreement each person approved, with evidence attached.

The first use is two developers with separate repositories. Alice's agent owns a backend, Bob's a client, and they disagree about an API. The agents work it out, each writes its side of the change, and each person gets a pull request that says what was agreed.

Existing projects either assume agents are HTTP services, assume one team that trusts its relay and every agent on it, or have no mailbox for agents that are offline ([prior-art.md](prior-art.md)). None handles two people who do not fully trust each other, laptops behind NAT that are often asleep, and a relay neither side should have to trust.

## Principles

1. **The other side's messages are untrusted input.** Always, however friendly the contact.
2. **Security comes from limiting what can happen, not from telling a model to be careful.** Assume any model that reads the other side's text can be fully manipulated by it. Then make sure that even so, it cannot read, do or spend what it should not.
3. **The rule checker is code.** Every message in and every action out passes a deterministic check in the daemon. No model sits in that path.
4. **The other side can never grant itself anything.** Authority comes only from the local person.
5. **People approve exact things.** An approval names a hash. A model cannot produce one.
6. **The relay is not trusted** with content, and is trusted as little as possible with delivery.

## Parts

```
 Alice's machine                                           Bob's machine
┌───────────────────────────┐                        ┌───────────────────────────┐
│ Claude Code / Codex       │                        │ Claude Code / Codex       │
│        │ MCP tools, hooks │                        │        │ MCP tools, hooks │
│ ┌──────▼────────────────┐ │    ciphertext only     │ ┌──────▼────────────────┐ │
│ │ daemon                │ │   ┌──────────────┐     │ │ daemon                │ │
│ │  keys, event log      ├─┼──►│    relay     │◄────┼─┤  keys, event log      │ │
│ │  rule checker         │◄┼───┤  mailboxes   ├─────┼►│  rule checker         │ │
│ │  outbound guard       │ │   └──────────────┘     │ │  outbound guard       │ │
│ └──┬─────────────┬──────┘ │                        │ └───────────────────────┘ │
│    │             │        │                        │                           │
│  front desk    worker     │                        │                           │
│  (no tools)   (no tools)  │                        │                           │
└───────────────────────────┘                        └───────────────────────────┘
```

- **Relay.** A WebSocket server with a mailbox per device. It stores ciphertext until the recipient acknowledges it. Anyone can run one ([relay.md](relay.md)). It cannot read messages. It does know which device sends to which, because it checks who logs in.
- **Daemon.** One per person. Holds the keys, the event log and the contacts, runs the rule checker and the outbound guard ([guard.md](guard.md)), and talks to the relays.
- **Front desk.** A model with no tools that answers a contact's questions from files its person shared with that contact ([front-desk.md](front-desk.md)). It can run while the person is away.
- **Worker.** The same tool-less model, given an agreed contract and files its person chose, that proposes edits. Code checks the edits and builds the patch. Nothing it writes is run.
- **Adapters.** An MCP server and hooks, so Claude Code and Codex can use Counterpart ([mcp.md](mcp.md)).
- **Viewer.** A local web page that shows threads, contracts, evidence and what waits for you. It only reads. Approving happens in the terminal.

## Identity

- A **person** has a root key. Contacts pin it when they pair ([pairing.md](pairing.md)). The root key is locked with a passphrase. The daemon cannot use it; only a command the person runs can, to approve a contract, release a held message or renew a device.
- A **device** has its own signing and encryption keys and a credential signed by the root key. Credentials last 90 days. A device whose root key is locked is renewed with `cpart renew`; `cpart status` says when that is due. There is one device per person for now.
- Names are local. "bob" is what Alice calls Bob. The other side never chooses how it appears on your screen.

## Threads and the two lanes

A thread is a log of signed events between two people. Events name earlier events, so the log is a graph, not a line, and each side applies events in an order consistent with those references. An event whose earlier events have not arrived is held. If they stay missing, the daemon asks their author to send them again. Each daemon also tells the other which events it applied, so a sender can tell "the relay has it" from "their daemon has it" ([protocol.md](protocol.md#resend-and-receipts)).

Every event is in one of two lanes:

- **Talk.** Free text between agents. Useful, binding on nobody, and always treated as untrusted. Nothing said here changes what anyone is allowed to do.
- **Act.** Typed, signed operations: propose, accept, decline or withdraw a contract, and send evidence about a repository. Only these change what has been agreed or what is shown as checked, and code checks each one.

Text from the other side never becomes a file path, a command, a URL or a permission.

### Pull, not push

The other side's text does reach one privileged agent: your own coding session, when it asks. If you tell your agent "ask Bob's agent how X works", the answer has to come back into your session. It does so only on an explicit read, inside an envelope that marks it as someone else's words. Nothing the other side writes is pushed into a session, put in a tool description, or shown in a list. What can be pushed is a notice that something arrived, built from fixed words and local values. This is the same risk as your agent reading a web page, and it is yours to supervise.

## Prompt injection

The threat: Bob's agent, or Bob, or someone who took over Bob's machine, sends text designed to make Alice's agent leak her code, run something, or agree to something.

The defences, in order of how much we rely on them:

1. **Nothing to steal.** The front desk sees the thread and what was shared with that contact, nothing else. It has no file access and no tools. Fully taken over, the worst it can do is disclose what was shared with that contact anyway.
2. **Nothing to do.** The other side's text cannot cause local effects. Effects come only from act-lane operations, checked by code.
3. **Work without running anything.** A worker has no tools and sees only the files its person chose. Its output is a set of edits that code checks and a person reviews. Nothing it writes is run on the owner's machine.
4. **Approvals outside the model.** An approval is a signature by the root key, which is locked with the passphrase. An agent on the same machine, even one with a shell, can read the key file and cannot sign with it. This holds while the machine is honest: a keylogger or a replaced `cpart` defeats it. Agents can propose, because a proposal binds nobody.
5. **What is pushed is a fixed template.** Hooks and `--notify` notices carry the local contact name, ids, counts and event types, never the other side's words, and are capped per hour ([mcp.md](mcp.md#replies-in-a-live-session-hooks)).
6. **The outbound guard.** Code holds a message that carries a secret it knows or recognises before it leaves ([guard.md](guard.md)). It catches a fooled agent using Counterpart, not an agent that sends the secret some other way.
7. **A hostile-peer suite** that runs with the tests on every commit ([gauntlet.md](gauntlet.md)). Results for rules enforced in code and for model behaviour are reported apart, because only the first are guarantees.

What we do not claim: that a model given the other side's text will resist it, or that the guard catches every secret. [redteam.md](redteam.md) measures how a tool-using agent behaves.

## Cost and loops

Each side pays for its own model use. Before the daemon starts any model work it takes a slot from a budget the local person set for that thread. Duplicates, receipts and status events take nothing and start no model. When the slots run out the thread pauses and asks the person. The other side cannot refill them.

## From agreement to pull request

**Nothing a model writes is run on the owner's machine.** Not tests, not builds, not scripts. A sandbox cannot be verified on an arbitrary laptop, and running tests after applying a patch written under the influence of the other side's contract is remote code execution. Code runs where a sandbox already exists: the repository's own CI, on hosted runners, with no secrets.

**The worker is the front desk's model, not an agent with file tools.** Confining an agent's file access to one directory cannot be demonstrated either. So the daemon gives the tool-less model the agreed contract, a brief from its own person, and the contents of files the person named. It answers with structured edits. Code checks every edit: only the named paths, no symlinks, no binaries, no executable bits, nothing under `.github/`, no manifests, lockfiles or install scripts unless the person allowed them. The daemon computes the diff itself from the bytes before and after.

**Publishing has its own gate.** `cpart pr`, run by the person in their real repository, shows the repository, its visibility, the patch and what will be published about the agreement, and binds the review to a base commit and a patch hash. It writes the agreement file and bindings itself; the worker cannot. Git runs with hooks, filters and external diff tools disabled.

**CI checks the link between agreement and code.** A verifier, run from the protected base branch against a chosen pull request, reads the pull request's files as data and checks that the agreement verifies, its signers are the ones pinned on the base branch, each bound part is byte-identical to the file at its path, and fixtures behave as the agreed schema says ([verify.md](verify.md)).

**Evidence between the two sides** is an act-lane event naming the agreement, the repository, the commits, the hashes of the bindings and trust policy, the verifier, per-part results and the CI run. The receiver recomputes what it can and shows the rest as the other side's claim ([protocol.md](protocol.md#evidence)). A sender who lies can name the right digests for a repository that holds something else; only the receiver reading that repository, or a CI run they trust, settles it.

## Decisions and why

- **Our own relay, not Matrix.** Matrix brings homeserver operations and a heavy client for features we do not need. A relay that stores opaque blobs is small: ours is under 600 lines.
- **HPKE and Ed25519 now, MLS later.** Messages between two people need no group protocol. The price is no forward secrecy, which we state. MLS would come with groups.
- **Aligned with A2A, not built on it.** Thread events map onto A2A messages, tasks and artifacts, so an A2A binding can be added. Encryption, approvals and agreements are ours. We will not call it A2A-compatible without conformance tests.
- **TypeScript on Node 24, run directly.** One language for relay, daemon, CLI, MCP server and viewer. SQLite is built into Node. A checkout runs the TypeScript directly. The npm package is a bundle made by `scripts/build.ts`, because Node does not strip types from files under `node_modules`.
- **Subscription logins first.** Most people use Claude Code and Codex through a subscription, not an API key, so the front desk runs on the `claude` CLI started with no tools, or on the Anthropic API when `ANTHROPIC_API_KEY` is set.
- **No front desk or worker on Codex.** The bar is the one the `claude` adapter meets: the process must say in machine-readable output that it has no tools, or run where a tool call can do nothing and report every tool call so the adapter can fail on one. Codex met neither when checked on 2026-11-13 (codex-cli 0.166.0, ChatGPT login, gpt-6-astra):
  - `codex exec --json` prints no list of tools. A default `codex exec -s read-only` session in an empty directory had about 230 tools, 205 of them the account's connected apps. Those run on OpenAI's side, so the sandbox does not limit them.
  - With every flag and feature we found turned off, the model still reported 15 tools, among them `exec`, `apply_patch` and agent tools.
  - Asked to call five of them, the model did. The `--json` stream showed none of the calls, so "fail on any tool call" would not have fired.
  - An OpenAI API-key adapter (a plain request with no tools declared) would meet the bar. It is not written, because there was no key to test it with.

## Not built

- Forward secrecy, key revocation, and more than one device per person.
- Grants: short-lived permissions a person issues to limit what a session acting for them can do. Until they exist, a coding session that reads the other side's text is limited only by its own permission prompts.
- A hosted relay. You run your own ([relay.md](relay.md)).
- The other side's evidence shown on your pull request, and a CI check that rejects stale evidence.

Nothing has run on macOS or Windows. [verification.md](verification.md) lists what has run.
