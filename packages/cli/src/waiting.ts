// Lines for `cpart status` about threads a contact is waiting in, and about a
// relay that refuses the login. Local names, short thread ids, counts and
// times only: the contact's words and the thread's goal are theirs and are
// never printed here.
import type { RelayStatus, Unanswered } from "@counterpart/daemon";

// Older than this, a thread the contact wrote last is taken as finished.
export const STATUS_WINDOW = 7 * 86_400_000;
const SHOWN = 5;

export const ago = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "less than a minute ago";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.floor(h / 24)} days ago`;
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

// What is waiting, as one fixed phrase: "new thread, 2 messages".
export const what = (u: Unanswered): string => [...(u.opened ? ["new thread"] : []), ...(u.messages || !u.opened ? [plural(u.messages, "message")] : [])].join(", ");

export function unansweredLines(list: Unanswered[], now: number): string[] {
  const lines = list.slice(0, SHOWN).map((u) => {
    const ref = u.thread.slice(0, 8);
    return `  ${u.contact} wrote in thread ${ref}: ${what(u)}, the last ${ago(now - u.lastAt)}. Nobody here has read it\n      cpart log ${ref}, then cpart say ${ref} "...", or answer from Claude Code or Codex`;
  });
  if (list.length > SHOWN) lines.push(`  and ${plural(list.length - SHOWN, "more thread")} like these\n      cpart threads`);
  return lines;
}

// The home relay turned this daemon's login away since the daemon started.
export function refusedLine(home: string, rows: RelayStatus[], since: number, safe: (s: string) => string): string[] {
  const s = rows.find((r) => r.url === home && r.at >= since);
  const code = !s || s.connected || !s.error ? null : /^refused the login: ([a-z_]{1,40})$/.exec(s.error)?.[1];
  if (!code) return [];
  const fix =
    code === "wrong_relay_url" ? `whoever runs the relay must restart it with --url ${safe(home)} (and --url for each other address people use)`
    : code === "auth_failed" ? "compare date -u here with the relay machine's: the clocks must agree to within 5 minutes"
    : `ask whoever runs the relay what ${code} means there`;
  return [`  the relay at ${safe(home)} refused to log you in (${code}). Nothing is sent or received until it lets you in\n      ${fix}. Your daemon keeps trying by itself`];
}
