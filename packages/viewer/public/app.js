"use strict";

// Everything a contact wrote is hostile. This file never parses a string as
// markup: text reaches the page through text nodes only, and the test suite
// fails if an HTML-parsing sink appears here.

const TOKEN_KEY = "counterpart-viewer-token";
const POLL_MS = 1500;

const main = document.getElementById("main");
const nav = document.getElementById("nav");
const statusLine = document.getElementById("status");

const state = {
  token: null,
  overview: null,
  thread: null,
  threadId: null,
  threadMissing: false,
  etags: new Map(),
  problem: null,
  rendered: "",
  renderedView: "",
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

// ---- hostile text ----

const NAMES = new Map([
  [0x00, "NUL"], [0x07, "BEL"], [0x08, "BS"], [0x0b, "VT"], [0x0c, "FF"], [0x0d, "CR"], [0x1b, "ESC"], [0x7f, "DEL"],
  [0xad, "SHY"], [0x61c, "ALM"], [0x200b, "ZWSP"], [0x200e, "LRM"], [0x200f, "RLM"],
  [0x202a, "LRE"], [0x202b, "RLE"], [0x202c, "PDF"], [0x202d, "LRO"], [0x202e, "RLO"],
  [0x2028, "LS"], [0x2029, "PS"], [0x2060, "WJ"], [0x2066, "LRI"], [0x2067, "RLI"], [0x2068, "FSI"], [0x2069, "PDI"],
  [0xfeff, "BOM"],
]);

// Characters that draw nothing but can move the cursor, reorder what follows
// or hide text. Joiners used by emoji and by Persian and Indic scripts are left alone.
function invisible(cp) {
  return (
    (cp < 0x20 && cp !== 0x0a && cp !== 0x09) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad || cp === 0x61c || cp === 0x180e || cp === 0x200b || cp === 0x200e || cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) || cp === 0x2028 || cp === 0x2029 ||
    (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff || (cp >= 0xfff9 && cp <= 0xfffb) ||
    (cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

const codeOf = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

// Tag characters are invisible copies of ASCII, used to hide instructions in
// plain sight. The label spells out the letter each one carries.
function label(cp) {
  if (cp > 0xe0020 && cp < 0xe007f) return `TAG ${String.fromCodePoint(cp - 0xe0000)}`;
  return NAMES.get(cp) ?? codeOf(cp);
}

function visible(text) {
  const out = document.createDocumentFragment();
  let run = "";
  const flush = () => {
    if (run) out.append(run);
    run = "";
  };
  for (const ch of text.replace(/\r\n/g, "\n")) {
    const cp = ch.codePointAt(0);
    if (!invisible(cp)) {
      run += ch;
      continue;
    }
    flush();
    out.append(h("span", { class: "ctl", title: `${codeOf(cp)}, shown as a label so it cannot act` }, label(cp)));
  }
  flush();
  return out;
}

// ---- time ----

const fmtClock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtShort = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" });

const dayKey = (ms) => new Date(ms).toDateString();
const clock = (ms) => fmtClock.format(ms);
const when = (ms) => (dayKey(ms) === dayKey(Date.now()) ? clock(ms) : `${fmtShort.format(ms)}, ${clock(ms)}`);
const stamp = (ms, text, title) => h("time", { datetime: new Date(ms).toISOString(), title: title ?? fmtFull.format(ms) }, text ?? when(ms));

// ---- data ----

function takeToken() {
  const m = /^#token=([A-Za-z0-9_-]{20,})$/.exec(location.hash);
  if (m) {
    state.token = m[1];
    try {
      sessionStorage.setItem(TOKEN_KEY, m[1]);
    } catch {}
    history.replaceState(null, "", "/#/threads");
    return;
  }
  try {
    state.token = sessionStorage.getItem(TOKEN_KEY);
  } catch {}
}

// Returns undefined when nothing changed since the last answer.
async function api(path) {
  const headers = { Authorization: `Bearer ${state.token}` };
  const etag = state.etags.get(path);
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(path, { headers, cache: "no-store", credentials: "omit" });
  if (res.status === 304) return undefined;
  if (res.status === 401) throw new Error("key");
  if (res.status === 404) {
    state.etags.delete(path);
    return null;
  }
  if (!res.ok) throw new Error("server");
  state.etags.set(path, res.headers.get("ETag"));
  return res.json();
}

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const m = /^t\/([A-Za-z0-9_-]{16,64})$/.exec(hash);
  if (m) return { view: "thread", id: m[1] };
  return { view: ["contacts", "refused", "me"].includes(hash) ? hash : "threads" };
}

async function refresh() {
  if (!state.token) {
    state.problem = "key";
    return paint();
  }
  const r = route();
  try {
    const overview = await api("/api/overview");
    if (overview) state.overview = overview;
    if (r.view === "thread") {
      if (state.threadId !== r.id) {
        state.threadId = r.id;
        state.thread = null;
        state.threadMissing = false;
        state.etags.delete(`/api/threads/${r.id}`);
      }
      const thread = await api(`/api/threads/${r.id}`);
      if (thread === null) state.threadMissing = !state.thread;
      else if (thread) {
        state.thread = thread;
        state.threadMissing = false;
      }
    }
    state.problem = null;
  } catch (e) {
    state.problem = e.message === "key" ? "key" : "offline";
  }
  paint();
}

let timer = null;
async function loop() {
  clearTimeout(timer);
  if (!document.hidden) await refresh();
  timer = setTimeout(loop, POLL_MS);
}

// ---- views ----

const code = (text) => h("code", null, text);
const empty = (title, ...lines) => h("div", { class: "empty" }, h("p", { class: "empty-title" }, title), lines.map((l) => h("p", null, l)));
const page = (title, lead, ...body) => [h("header", { class: "page-head" }, h("h1", null, title), lead && h("p", { class: "lead" }, lead)), ...body];

function threadsView(o) {
  if (!o.threads.length) {
    const next = o.contacts.some((c) => c.state === "active")
      ? ["Start one from a terminal: ", code("cpart open <contact> <goal>")]
      : ["You need a contact first. Run ", code("cpart invite <name>"), " and send them what it prints."];
    return page("Threads", null, empty("No threads yet", next));
  }
  const rows = o.threads.map((t) =>
    h("a", { class: "row", href: `#/t/${encodeURIComponent(t.id)}` },
      h("span", { class: "cell about" }, h("span", { class: t.openedByMe ? "clip" : "clip theirs", dir: "auto" }, t.goal ? visible(t.goal) : "No goal given")),
      h("span", { class: "cell with" }, t.contact),
      h("span", { class: "cell num events" }, String(t.events), h("span", { class: "unit" }, t.events === 1 ? " event" : " events")),
      h("span", { class: "cell num last" }, stamp(t.lastAt)),
    ),
  );
  const anyTheirs = o.threads.some((t) => !t.openedByMe);
  return page("Threads", null,
    h("div", { class: "table threads" },
      h("div", { class: "thead" }, h("span", null, "Goal"), h("span", null, "With"), h("span", { class: "num" }, "Events"), h("span", { class: "num" }, "Last activity")),
      rows,
    ),
    anyTheirs && h("p", { class: "note" }, h("span", { class: "theirs sample" }, "Shaded"), " goals were written by the other side."),
  );
}

function turn(e, contact, prev) {
  const mine = e.mine;
  const held = e.status === "pending";
  const cont = prev && prev.mine === mine && prev.status === e.status && dayKey(prev.createdAt) === dayKey(e.createdAt);
  const title = mine ? `Sent ${fmtFull.format(e.createdAt)}` : `Sent ${fmtFull.format(e.createdAt)} by their clock. Arrived ${fmtFull.format(e.receivedAt)}`;
  const body = e.text === null ? h("span", { class: "kind" }, e.type) : visible(e.text);
  return h("li", { class: `turn ${mine ? "mine" : "theirs-turn"}${cont ? " cont" : ""}${held ? " held" : ""}`, "data-id": e.id },
    h("div", { class: "who" }, h("span", { class: "name" }, mine ? "You" : contact), stamp(e.createdAt, clock(e.createdAt), title), held && h("span", { class: "flag" }, "held")),
    h("div", { class: mine ? "said" : "said theirs", dir: "auto" }, body),
  );
}

function threadView(data) {
  const { thread: t, events } = data;
  const opened = events.find((e) => e.type === "thread.opened");
  const talk = events.filter((e) => e.type !== "thread.opened");
  const applied = talk.filter((e) => e.status === "applied");
  const held = talk.filter((e) => e.status === "pending");
  const who = t.openedByMe ? "you" : t.contact;

  const items = [];
  let prev = null;
  for (const e of applied) {
    if (!prev || dayKey(prev.createdAt) !== dayKey(e.createdAt)) items.push(h("li", { class: "day" }, fmtDay.format(e.createdAt)));
    items.push(turn(e, t.contact, prev));
    prev = e;
  }

  return [
    h("p", { class: "crumb" }, h("a", { href: "#/threads" }, "Threads"), h("span", { "aria-hidden": "true" }, " / "), t.contact),
    h("header", { class: "thread-head" },
      h("p", { class: "label" }, `Goal, set by ${who}`),
      h("h1", { class: t.openedByMe ? "goal" : "goal theirs", dir: "auto" }, t.goal ? visible(t.goal) : "No goal given"),
      h("p", { class: "meta" },
        opened ? ["Opened ", stamp(opened.createdAt), " · "] : null,
        `${t.events} ${t.events === 1 ? "event" : "events"} · last activity `, stamp(t.lastAt),
      ),
    ),
    h("p", { class: "note" }, h("span", { class: "theirs sample" }, "Shaded"), ` text was written by ${t.contact}'s side. Nothing in it changes what your agent may do.`),
    applied.length ? h("ol", { class: "transcript" }, items) : empty("No messages yet", "The thread is open. Nobody has written in it."),
    held.length > 0 &&
      h("section", { class: "held-block" },
        h("h2", null, held.length === 1 ? "1 message held" : `${held.length} messages held`),
        h("p", { class: "lead" }, "These arrived before the messages they refer to. They join the thread when the rest arrives."),
        h("ol", { class: "transcript" }, held.map((e, i) => turn(e, t.contact, held[i - 1] ?? null))),
      ),
  ];
}

function contactsView(o) {
  if (!o.contacts.length) {
    return page("Contacts", null, empty("No contacts yet", ["Run ", code("cpart invite <name>"), " and send them what it prints. The name is what you call them."]));
  }
  return page("Contacts", "Compare the safety code with each contact by phone or in person. If the two codes differ, someone is in the middle.",
    h("div", { class: "cards" },
      o.contacts.map((c) =>
        h("section", { class: "card" },
          h("div", { class: "card-head" },
            h("h2", null, c.name),
            h("p", { class: "state" }, c.state === "active" ? "Active" : "Waiting for them to accept"),
          ),
          h("p", { class: "safety", "aria-label": `Safety code ${c.safetyCode}` }, c.safetyCode.split(" ").map((g) => h("span", null, g))),
          h("dl", { class: "facts" },
            h("dt", null, "Human id"), h("dd", { class: "mono" }, c.human),
            h("dt", null, "Device id"), h("dd", { class: "mono" }, c.device),
            h("dt", null, "Device valid until"), h("dd", null, stamp(c.credentialExpiresAt, fmtShort.format(c.credentialExpiresAt) + " " + new Date(c.credentialExpiresAt).getFullYear())),
            h("dt", null, "Relay"), h("dd", { class: "mono" }, c.relay),
          ),
        ),
      ),
    ),
  );
}

function refusedView(o) {
  if (!o.rejects.length) return page("Refused", null, empty("Nothing has been refused", "Messages that fail a check are listed here with the reason."));
  return page("Refused", "Your daemon dropped these. None of them was applied.",
    h("div", { class: "table refused" },
      h("div", { class: "thead" }, h("span", null, "When"), h("span", null, "Reason"), h("span", null, "Message id")),
      o.rejects.map((r) =>
        h("div", { class: "row" },
          h("span", { class: "cell at" }, stamp(r.at)),
          h("span", { class: "cell reason" }, visible(r.reason)),
          h("span", { class: "cell mono id" }, r.wireId ? visible(r.wireId) : "unknown"),
        ),
      ),
    ),
  );
}

function meView(o) {
  return page("Identity", "This is you on this machine. Contacts pin your human key, and the relay sees only ciphertext.",
    h("dl", { class: "facts wide" },
      h("dt", null, "Human id"), h("dd", { class: "mono" }, o.me.human),
      h("dt", null, "Device id"), h("dd", { class: "mono" }, o.me.device),
      h("dt", null, "Relay"), h("dd", { class: "mono" }, o.me.relay),
      h("dt", null, "Root public key"), h("dd", { class: "mono" }, o.me.rootKey),
      h("dt", null, "Data folder"), h("dd", { class: "mono" }, o.me.home),
    ),
  );
}

// ---- painting ----

const SECTIONS = [
  ["threads", "Threads", (o) => o.threads.length],
  ["contacts", "Contacts", (o) => o.contacts.length],
  ["refused", "Refused", (o) => o.rejects.length],
  ["me", "Identity", () => null],
];

function paintNav(r) {
  const current = r.view === "thread" ? "threads" : r.view;
  nav.replaceChildren(
    ...SECTIONS.map(([id, label, count]) => {
      const n = state.overview ? count(state.overview) : null;
      return h("a", { href: `#/${id}`, "aria-current": id === current ? "page" : undefined }, h("span", null, label), n ? h("span", { class: "count" }, String(n)) : null);
    }),
  );
}

function paintStatus() {
  const text =
    state.problem === "offline" ? "The viewer has stopped. Start it again to see new messages."
    : state.problem === "key" ? ""
    : `Read only. Served from ${location.host} on this machine.`;
  if (statusLine.textContent !== text) statusLine.textContent = text;
  statusLine.classList.toggle("warn", state.problem === "offline");
}

function paint() {
  const r = route();
  paintNav(r);
  paintStatus();

  let key;
  let build;
  let title = "Counterpart";
  if (state.problem === "key") {
    key = "key";
    build = () => [empty("This tab has no key", "Open the full link that cpart printed. The key in it lets this page read your transcripts.")];
  } else if (!state.overview) {
    key = `wait:${state.problem}`;
    build = () => (state.problem ? [empty("The viewer is not answering", "Start it again and open the link it prints.")] : []);
  } else if (r.view === "thread") {
    if (state.threadMissing) {
      key = `missing:${r.id}`;
      build = () => [h("p", { class: "crumb" }, h("a", { href: "#/threads" }, "Threads")), empty("This thread is not on this machine", "The link may be from another identity.")];
    } else if (!state.thread || state.threadId !== r.id) {
      key = `loading:${r.id}`;
      build = () => [];
    } else {
      key = `thread:${state.etags.get(`/api/threads/${r.id}`)}`;
      build = () => threadView(state.thread);
      title = `Thread with ${state.thread.thread.contact} · Counterpart`;
    }
  } else {
    key = `${r.view}:${state.etags.get("/api/overview")}:${dayKey(Date.now())}`;
    const views = { threads: threadsView, contacts: contactsView, refused: refusedView, me: meView };
    build = () => views[r.view](state.overview);
    title = `${SECTIONS.find((s) => s[0] === r.view)[1]} · Counterpart`;
  }
  if (document.title !== title) document.title = title;
  if (key === state.rendered) return;

  const viewKey = `${key.split(":")[0]}:${r.id ?? ""}`;
  const sameView = viewKey === state.renderedView;
  state.renderedView = viewKey;
  const atBottom = sameView && r.view === "thread" && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48;
  state.rendered = key;
  main.replaceChildren(...build().flat().filter(Boolean));
  if (!sameView) window.scrollTo(0, 0);
  else if (atBottom) window.scrollTo(0, document.documentElement.scrollHeight);
}

takeToken();
window.addEventListener("hashchange", () => {
  paint();
  void loop();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void loop();
});
void loop();
