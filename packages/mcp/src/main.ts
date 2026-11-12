#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { Counterpart } from "@counterpart/daemon";
import { startMcpServer } from "./server.ts";

// Stdout carries the MCP protocol, so anything for a person goes to stderr.
try {
  const node = Counterpart.open(process.env.CPART_HOME ?? join(homedir(), ".counterpart"));
  await node.renewIfDue();
  await startMcpServer(node);
} catch (e) {
  console.error(`counterpart mcp: ${(e as Error).message}`);
  process.exit(1);
}
