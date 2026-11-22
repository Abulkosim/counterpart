# Security

Counterpart is experimental. Its encryption is built from standard parts (HPKE, Ed25519, CPace), but the way they are combined is ours and has had no outside review. Do not rely on it for secrets yet.

## Reporting a problem

Report it privately through GitHub: on this repository, open the Security tab and choose "Report a vulnerability". Please do not open a public issue or pull request for it.

Say what you did, what happened, and what you expected. A failing test or a script is the most useful form; the gauntlet cases in `packages/gauntlet/src/cases` show the shape. This is a small project with no security team and no bounty. Fixes go into the latest release only.

## In scope

Anything where the code breaks a promise it makes:

- A relay, a stranger or a contact reading, forging, replaying or redirecting messages, or getting a daemon to apply an event the rules in [docs/protocol.md](docs/protocol.md) refuse.
- Completing a short-code pairing without the code, or guessing it faster than [docs/pairing.md](docs/pairing.md) says.
- An approval, release, `guard off` or share made without the owner's passphrase at a terminal.
- The other side's text reaching a coding session outside an envelope: in a tool description, an error, a hook or a notice ([docs/mcp.md](docs/mcp.md#trust-rules)).
- The front desk reading a file that was not shared, or sending a citation that does not check ([docs/front-desk.md](docs/front-desk.md)).
- A worker's edit getting past the checker, or `cpart pr` publishing something other than what was reviewed.
- The verifier passing a tree that does not carry what was signed ([docs/verify.md](docs/verify.md)).
- The viewer or the CLI running or rendering the other side's text as anything but text.
- A secret the guard should know getting past it in a way [docs/guard.md](docs/guard.md#what-it-does-not-catch) does not already list.

## Not in scope

- The limits stated below and in each doc. They are known.
- A model being talked into something, when no rule enforced in code was broken. That is measured, not promised ([docs/redteam.md](docs/redteam.md)).
- Attacks that need the owner's passphrase, or a machine already compromised (a keylogger, a replaced `cpart`).
- An open relay being slowed or filled by someone who can reach it. Its limits make abuse slower, not impossible.

## Stated limits

- No outside review of the cryptography.
- No forward secrecy. A leaked device key exposes recorded messages to that device.
- The relay sees which device writes to which, when, and how much.
- The root key lives on the same device, locked with a passphrase. Someone with the laptop and the passphrase is you until contacts remove you by hand. Revocation is not built.
- Approvals cannot be revoked.
- A coding session that reads the other side's text through the MCP tools can be talked into misusing its own shell and file tools. Nothing in code stops that. Keep permission prompts on.
- The outbound guard is a filter on one channel. A secret it does not know, an encoding it does not list, or an agent that sends some other way gets through.
- With a subscription login, the front desk's `claude` CLI adds the account email, OS version and date to the model's context.
- Nothing has run on macOS or Windows.

The full list, kept up to date with each run, is at the end of [docs/verification.md](docs/verification.md#known-limits).
