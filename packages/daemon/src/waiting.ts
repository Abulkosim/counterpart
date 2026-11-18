// Threads where a contact wrote last and nobody on this side has answered or
// read it yet. `cpart status` lists them, and the hooks tell a session about
// them. Only ids, counts, times and the local contact name come out of here:
// never the contact's text or the thread's goal.
//
// This file imports nothing from the rest of the daemon, so a hook that runs
// on every prompt of every session can ask without loading it all.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Unanswered {
  thread: string;
  contact: string;
  // The contact opened the thread and this side has written nothing in it.
  opened: boolean;
  // This side opened the thread, so its id is one this side made. When the
  // contact opened it, the contact chose the id, up to 64 characters.
  openedHere: boolean;
  // Messages from the contact after this side's last event and last read.
  messages: number;
  firstOrd: number;
  lastOrd: number;
  lastAt: number;
}

// The read marks table. The node creates it; a store made by an older
// version has none until the node next opens it.
export const READS_TABLE = "CREATE TABLE IF NOT EXISTS thread_reads (thread_id TEXT PRIMARY KEY, ord INTEGER NOT NULL, at INTEGER NOT NULL)";

// Contact events that ask for an answer. A contract proposal has its own line.
const ASKS = "('thread.opened', 'talk.posted')";

export function unanswered(db: DatabaseSync, since: number): Unanswered[] {
  const reads = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_reads'").get() !== undefined;
  const rows = db
    .prepare(
      `WITH mine AS (SELECT thread_id, MAX(ord) AS ord FROM events WHERE mine = 1 AND status = 'applied' AND ord IS NOT NULL GROUP BY thread_id)
       SELECT t.id AS thread, c.name AS contact, t.opened_by_me AS opened_here,
         SUM(json_extract(e.json, '$.type') = 'thread.opened') AS opened,
         SUM(json_extract(e.json, '$.type') = 'talk.posted') AS messages,
         MIN(e.ord) AS first_ord, MAX(e.ord) AS last_ord, MAX(e.received_at) AS last_at
       FROM threads t
       JOIN contacts c ON c.root_key = t.contact_root AND c.state = 'active'
       JOIN events e ON e.thread_id = t.id AND e.author_root = t.contact_root AND e.mine = 0 AND e.status = 'applied' AND e.ord IS NOT NULL
       LEFT JOIN mine m ON m.thread_id = t.id
       ${reads ? "LEFT JOIN thread_reads r ON r.thread_id = t.id" : ""}
       WHERE e.ord > MAX(COALESCE(m.ord, 0), ${reads ? "COALESCE(r.ord, 0)" : "0"}) AND json_extract(e.json, '$.type') IN ${ASKS}
       GROUP BY t.id HAVING MAX(e.received_at) >= ?
       ORDER BY last_at DESC`,
    )
    .all(since) as { thread: string; contact: string; opened_here: number; opened: number; messages: number; first_ord: number; last_ord: number; last_at: number }[];
  return rows.map((r) => ({ thread: r.thread, contact: r.contact, opened: r.opened > 0, openedHere: r.opened_here === 1, messages: r.messages, firstOrd: r.first_ord, lastOrd: r.last_ord, lastAt: r.last_at }));
}

// The same, from a home's store, opened read-only. An empty list when there is no store.
export function unansweredIn(home: string, since: number): Unanswered[] {
  const file = join(home, "state.db");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    return unanswered(db, since);
  } finally {
    db.close();
  }
}
