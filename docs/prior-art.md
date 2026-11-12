# Prior art

Surveyed 2026-11-12 from READMEs, docs and code. Stars are as of that date.

| Project | What it does | Trust model | Worth taking |
| --- | --- | --- | --- |
| [A2A](https://github.com/a2aproject/A2A) (26k, Apache-2.0) | Agent cards, tasks, messages, parts, artifacts; JSON-RPC, gRPC, REST and custom bindings | HTTP-layer auth. Agents are reachable services. No end-to-end encryption, nothing on injection | The vocabulary, signed agent cards, the extension mechanism |
| [ANP](https://github.com/agent-network-protocol/AgentNetworkProtocol) (1.5k, Apache-2.0) | DID identity on HTTPS domains; encrypted messaging with prekeys and ratchets | Each owner runs a domain | Per-device mailbox and prekey design, for when we add forward secrecy |
| [SLIM](https://github.com/agntcy/slim) (233, Apache-2.0) | Rust message routing with MLS at the session layer | Nodes cannot read content. No mailbox found for offline clients | MLS usage as a reference for groups |
| [claude-mesh](https://github.com/pouriamrt/claude-mesh) (23, MIT) | Relay plus MCP channel bridge between Claude Code instances | One team, one admin, trusted relay, plaintext | Escaping of channel content, reply-storm limiter, its notes on channel pitfalls |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) (250 + 2.2k, MIT with a rider excluding OpenAI and Anthropic) | Mail-like coordination for coding agents, polled | One operator. Optional signed registration | Contact-approval model. Ideas only, because of the licence |
| [claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge) (3.6k) | Local multi-agent terminal workspace | Same owner, same machine | Deliver at a safe step boundary |
| [agent-intercom](https://github.com/dataforxyz/agent-intercom-claude) (AGPL) | Same-machine broker across harnesses | Same owner | Its comparison of ways to wake an agent |
| [CaMeL](https://github.com/google-research/camel-prompt-injection) (421, Apache-2.0, unmaintained) | Research code: a planner that never sees untrusted data, a quarantined model that parses it, policy checks at each tool call | n/a | The pattern, not the code |

## How messages reach a live session

**Claude Code channels** (research preview). A local MCP server declares the `claude/channel` capability and emits `notifications/claude/channel`. The model sees the content inside a `<channel>` tag. There is no acknowledgement; events are dropped silently if the session did not opt in. A custom server needs a development flag with an interactive confirmation, and channels are ignored in headless mode. So channels can notify a session a human is sitting in, and cannot be the only delivery path.

**Codex app-server.** `turn/start` on an idle thread, `turn/steer` during an active turn. The daemon has to own the app-server process and track turn state. There is no documented way to attach to a terminal session that is already running.

Both confirm the plan: run our own workers first, and treat live sessions as a place to show notifications.

## The gap

No project combines: people who do not trust each other, an untrusted relay, offline laptops behind NAT, defences against injection that do not depend on the model behaving, and per-contact consent with budgets.
