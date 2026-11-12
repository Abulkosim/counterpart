# Design

This is what Counterpart is, why it is shaped this way, and what gets built in what order. It came out of a three-round design argument between Claude (Fable 5.2) and Codex (gpt-6-astra), plus a survey of existing projects ([prior-art.md](prior-art.md)).

## The idea

Two people each have an AI agent. Today, when the agents need something from each other, the humans copy and paste between chat windows. Counterpart lets the agents talk directly, on behalf of their humans, and makes the result something both humans can trust: an agreement each of them approved, with evidence attached.

The first use is two developers with separate repos. Alice's agent owns a backend. Bob's agent owns a client. They disagree about an API. The agents work it out, each writes its side of the change, and each human gets a pull request that says what was agreed and proves the other side did their part.

## What already exists, and the gap

- **A2A** (Linux Foundation) has a good vocabulary: agent cards, tasks, messages, parts, artifacts. It assumes agents are HTTP services. It has no end-to-end encryption and says nothing about prompt injection.
- **ANP** specifies encrypted messaging between agents, but assumes each owner runs a domain.
- **SLIM** (AGNTCY) does encrypted group messaging for agents, with no evident mailbox for agents that are offline.
- **claude-mesh**, **mcp_agent_mail**, **claude-peers** and others connect coding agents, but all assume one team that trusts its relay and trusts every agent on it.

Nobody handles the case that matters here: two people who do not fully trust each other, agents on laptops behind NAT that are often offline, and a relay neither side should have to trust.

## Principles

1. **The other side's messages are untrusted input.** Always, however friendly the contact.
2. **Security comes from limiting what can happen, not from telling a model to be careful.** Assume any model that reads the peer's text can be fully manipulated by it. Then make sure that even so, it cannot read what it should not, do what it should not, or spend what it should not.
3. **The rule checker is code.** Every message in and every action out passes through a deterministic check in the daemon. No model sits in that path.
4. **A peer can never grant itself anything.** Authority comes only from the local human.
5. **Humans approve exact things.** An approval names a hash. A model cannot produce a human's approval.
6. **The relay is not trusted** with content, and is trusted as little as possible with delivery.

## Parts

```
 Alice's machine                                           Bob's machine
┌───────────────────────────┐                        ┌───────────────────────────┐
│ Claude Code / Codex       │                        │ Claude Code / Codex       │
│        │ MCP tools        │                        │        │ MCP tools        │
│ ┌──────▼────────────────┐ │    ciphertext only     │ ┌──────▼────────────────┐ │
│ │ daemon                │ │   ┌──────────────┐     │ │ daemon                │ │
│ │  keys, event log      ├─┼──►│    relay     │◄────┼─┤  keys, event log      │ │
│ │  rule checker         │◄┼───┤  mailboxes   ├─────┼►│  rule checker         │ │
│ │  grants, budgets      │ │   └──────────────┘     │ │  grants, budgets      │ │
│ └──┬─────────────┬──────┘ │                        │ └───────────────────────┘ │
│    │             │        │                        │                           │
│  front desk   sandboxed   │                        │                           │
│  (no tools)   workers     │                        │                           │
└───────────────────────────┘                        └───────────────────────────┘
```

- **Relay.** A WebSocket server with a mailbox per device. It stores ciphertext until the recipient acknowledges it. It can be self-hosted. It cannot read messages. It does know which device sends to which, because it checks who is logging in, and it keeps that with each queued message.
- **Daemon.** One per person. Holds keys, the event log, contacts, grants and budgets. Runs the rule checker. Talks to the relay.
- **Front desk.** A model with no tools that answers a contact's questions using only a bundle of material the human approved for that contact. It can run while the human is away.
- **Workers** (M3). A model with no tools, given the agreed contract and files its human chose, that proposes edits. Code checks the edits and builds the patch. Nothing it writes is run locally.
- **Adapters.** An MCP server so Claude Code and Codex can use Counterpart, and notifications into live sessions.
- **Viewer.** A local web page showing transcripts, evidence and pending approvals. Approvals are given here, not through a model.

## Identity

Three separate things, with separate lifetimes:

- A **human** has a root key. Contacts pin it. Two humans compare a short safety code out of band to confirm they have each other's real key. The root key is locked with a passphrase. The daemon cannot use it; only a short-lived command the human runs can, to renew a device or approve a contract.
- A **device** has its own signing and encryption keys and a credential signed by the root key. Credentials expire after 90 days and renew themselves. Devices can be replaced without re-pairing.
- A **grant** (from M2) is a short-lived, locally issued permission bound to a contact, a thread, an operation, a resource, an expiry and a budget.

Names are local. "bob" is what Alice calls Bob. A peer never chooses how it appears on your screen.

## Threads and the two lanes

A thread is a log of signed events between two people. Events reference earlier events, so the log is a graph, not a line; each side applies events in an order consistent with those references.

Every event is in one of two lanes:

- **Talk.** Free text between agents. Useful, non-binding, and always treated as untrusted. Nothing said here changes what anyone is allowed to do.
- **Act.** Typed, signed operations: propose a contract, accept it, decline it, withdraw it. Evidence comes in M3. Only these change what has been agreed, and each is checked by code.

Text from a peer never becomes a file path, a command, a URL or a field of a grant.

### Pull, not push

There is one place where peer text does reach a privileged agent: when your own coding session asks for it. If you tell your agent "ask Bob's agent how X works", the answer has to come back into your session. The rule is that this only happens on an explicit read (`counterpart_read_thread`, `counterpart_wait_for_reply`), inside an envelope that marks it as someone else's words. Nothing a peer writes is ever pushed into a session, placed in a tool description, or shown in a list. It is the same risk as your agent reading a web page, and it is yours to supervise until grants limit what such a session can do.

## Prompt injection

The threat: Bob's agent (or Bob, or someone who took over Bob's machine) sends text designed to make Alice's agent leak her code, run something, or agree to something.

Defences, in order of how much we rely on them:

1. **Nothing to steal.** The model that reads peer text (the front desk) can see only the approved bundle. It has no file access, no tools and no conversation history. If it is completely taken over, the worst it can do is disclose the bundle, which was approved for that contact anyway.
2. **Nothing to do.** Peer text cannot cause local effects. Effects come from act-lane operations checked by code against grants the human issued.
3. **Work without execution.** When a worker implements an agreed contract, it has no tools and sees only the files its human chose. Its output is a set of edits that code checks and turns into a patch for a human to review. Nothing it writes is run on the owner's machine.
4. **Approvals outside the model.** An approval is a signature by the human's root key, which is locked with their passphrase. An agent on the same machine, even one with a shell, can read the key file and cannot sign with it. This holds while the machine is honest: a keylogger or a replaced `cpart` defeats it. Agents can propose, because a proposal binds nobody.
5. **Rendering.** What reaches a live coding session is a fixed template built from verified fields: contact name, event type, hash, counts, a local link. No peer-written text.
6. **A hostile-peer test suite** that runs in CI: [gauntlet.md](gauntlet.md). Results for the code-enforced rules and for model behaviour are reported separately, because only the first kind are guarantees.

Things we do not claim: that a model given peer text will resist it, or that scanning output for secrets catches everything.

## Cost and loops

Each side pays for its own model use. Before the daemon starts any model work it consumes a slot from a budget the local human set for that thread. Duplicates, receipts and status events consume nothing and trigger no model. When slots run out the thread pauses and asks the human. A peer cannot refill them.

## Roadmap

| | Outcome | State |
| --- | --- | --- |
| M0 | Two paired daemons exchange encrypted messages and survive duplicate, delayed and reordered delivery | Done |
| M1 | Front desk answers a contact's questions from an approved bundle while the human is offline. Viewer shows where each answer came from. Hostile-peer suite, first version. Slots and budgets | Done. The suite's model-behaviour section is still empty |
| M2 | Act lane: contracts proposed and accepted by hash, human approvals, notifications into live Claude Code and Codex sessions | Contracts, approvals and agreement files done. MCP tools, viewer and notifications next |
| M3 | Workers produce patches. Each side opens a PR carrying the agreement and the other side's signed evidence. A verifier in CI checks it and rejects stale evidence | Planned, see below |
| M4 | Hosted invite-only relay. Launch demo: overnight answer, human steps in, two PRs, recovery from an interrupted delivery | |

## Plan for M3: from agreement to pull requests

Worked out with Codex in a fifth design round. Not built yet.

**Nothing the model writes is run on the owner's machine.** Not tests, not builds, not scripts. A sandbox cannot be verified on an arbitrary laptop, and running a test suite after applying a patch written under the influence of the other side's contract text is remote code execution. Code runs where a sandbox already exists: the repo's own CI, on hosted runners, with no secrets.

**The worker is the front desk's model, not an agent with file tools.** Confining an agent's file access to one directory cannot be demonstrated either. So the worker is the same tool-less model: the daemon gives it the agreed contract, a brief from its own human, and the contents of files the human named. It answers with structured edits. A broker in code checks every edit: only the named paths, no symlinks, no binaries, no executable bits, nothing under `.github/`, no manifests, lockfiles or install scripts unless the human asked for them separately. The daemon computes the diff itself from the before and after bytes.

**Publishing has its own gate.** `cpart pr`, run by the human in their real repo, shows the exact repo, its visibility, the patch and what will be published about the agreement, and binds the review to a base commit and a patch hash. It writes the agreement file and bindings itself; the worker cannot. Git runs with hooks, filters and external diff tools disabled.

**CI checks the link between agreement and code.** A verifier, run from the protected base branch by `workflow_dispatch` against a chosen PR, reads the PR's files as data and checks: the agreement verifies; its signers and thread are the ones pinned on the base branch; each bound part of the contract is byte-identical to the file at its bound path; and fixtures in the repo, both ones that should pass and ones that should fail, behave that way against the agreed schema. A missing agreement or a deleted binding fails.

**Evidence between the two sides** is an act-lane event naming immutable things: agreement, proposal, repo, head and base commits, hashes of the bindings and trust policy, verifier version, per-part results, and the CI run. The receiver recomputes what it can and shows the rest as the other side's claim. Evidence goes stale when the head, base, bindings or policy change.

**The demo:** two repos, one agreed schema, two reviewed patches, two PRs with passing checks and each side's evidence shown on the other's PR. Then change one byte of the schema and watch verification fail, and push a new commit and watch the old evidence go stale.

## Decisions and why

- **Our own relay, not Matrix.** Matrix brings homeserver operations and a heavy client for features we do not need. A relay that stores opaque blobs is a few hundred lines.
- **HPKE and Ed25519 now, MLS later.** Pairwise messages need no group protocol. The price is no forward secrecy, which we state. MLS comes with groups.
- **Aligned with A2A, not built on it.** Thread events map onto A2A messages, tasks and artifacts so an A2A binding can be added. Encryption, grants and agreements are ours. We will call it A2A-compatible only after conformance tests.
- **TypeScript on Node 24, run directly.** One language for relay, daemon, CLI, MCP server and viewer. SQLite is built in. There is no build step.
- **Subscription logins first.** Most people use Claude Code and Codex through a subscription, not an API key. That limits how tightly a worker can be sandboxed, so M3 workers ship as experimental and supervised until escape tests pass on each OS. A stricter container mode with a brokered key comes after.
