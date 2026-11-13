#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { Counterpart } from "@counterpart/daemon";
import { startMcpServer } from "./server.ts";

// Stdout carries the MCP protocol, so anything for a person goes to stderr.
try {
  const node = Counterpart.open(process.env.CPART_HOME ?? join(homedir(), ".counterpart"));
  await node.renewIfDue();
  // `--notify` or CPART_NOTIFY=1 turns on notices into a live Claude Code session.
  const notify = process.argv.includes("--notify") || process.env.CPART_NOTIFY === "1";
  const port = process.env.CPART_VIEW_PORT;
  await startMcpServer(node, notify ? { notify: { log: (l) => console.error(`counterpart mcp: ${l}`), ...(port ? { viewerPort: Number(port) } : {}) } } : {});
} catch (e) {
  console.error(`counterpart mcp: ${(e as Error).message}`);
  process.exit(1);
}
