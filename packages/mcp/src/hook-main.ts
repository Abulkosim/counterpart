#!/usr/bin/env node
// What Claude Code runs for Counterpart's hooks: the same as `cpart hook
// <event>`, without loading the rest of the CLI, because some of these run on
// every prompt. Usage: hook-main.ts start|prompt|tool|stop|watch, hook JSON on stdin.
import { homedir } from "node:os";
import { join } from "node:path";
import { hookMain } from "./hooks.ts";

process.exitCode = await hookMain(process.argv[2] ?? "", process.env.CPART_HOME ?? join(homedir(), ".counterpart"));
