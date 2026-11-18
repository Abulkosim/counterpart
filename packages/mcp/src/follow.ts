import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ThreadSummary } from "@counterpart/daemon";

// counterpart_follow and counterpart_unfollow. The server keeps no state for
// them: Claude Code's PostToolUse hook sees the call with the session's id and
// records it (hooks.ts). The result says how to tell whether that happened.

const threadId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "not a thread id").describe("Thread id, as returned by counterpart_threads or counterpart_open_thread");

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

export function registerFollowTools(server: McpServer, findThread: (id: string) => ThreadSummary): void {
  const find = (id: string): ThreadSummary | CallToolResult => {
    try {
      return findThread(id);
    } catch (e) {
      return text((e as Error).message, true);
    }
  };

  server.registerTool(
    "counterpart_follow",
    {
      title: "Follow a thread",
      description:
        "Stay on a thread until the contact replies. Call it after asking the contact something the human is waiting for. In Claude Code with Counterpart's hooks, the session is told when the contact's side adds something (never what), and a stop is refused with a reminder to call counterpart_wait_for_reply while no reply has come, within a time limit. Call counterpart_unfollow when the conversation is settled.",
      inputSchema: { thread: threadId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ thread }) => {
      const t = find(thread);
      if ("content" in t) return t;
      return text(
        [
          `Asked to follow thread ${t.id} with ${t.contact}.`,
          "If Counterpart's hooks run in this session, a line starting \"Counterpart hook:\" confirms it right after this result.",
          "Without that confirmation nothing will remind or wake this session: call counterpart_wait_for_reply to wait for the reply.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "counterpart_unfollow",
    {
      title: "Stop following a thread",
      description: "Stop following a thread: the session is no longer kept on it. Arrivals in threads the session used are still announced, without their text.",
      inputSchema: { thread: threadId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ thread }) => {
      const t = find(thread);
      if ("content" in t) return t;
      return text(`No longer following thread ${t.id} with ${t.contact}.`);
    },
  );
}
