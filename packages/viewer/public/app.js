"use strict";

// Everything a contact wrote is hostile. This file never parses a string as
// markup: text reaches the page through text nodes only, and the test suite
// fails if an HTML-parsing sink appears here.
//
// The page only reads. It has no way to sign, decline or send anything: for
// those it prints the command to run in a terminal.

const TOKEN_KEY = "counterpart-viewer-token";
const POLL_MS = 1500;
const DAY_MS = 24 * 3600 * 1000;
const DIFF_CONTEXT = 3;

const main = document.getElementById("main");
const nav = document.getElementById("nav");
const statusLine = document.getElementById("status");

const state = {
  token: null,
  overview: null,
  data: new Map(), // api path -> answer, or null when the server has nothing there
  etags: new Map(),
  problem: null,
  rendered: "",
  renderedView: "",
  renderedNav: "",
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
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

// ---- time and sizes ----

const fmtClock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtShort = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" });

const dayKey = (ms) => new Date(ms).toDateString();
const clock = (ms) => fmtClock.format(ms);
const when = (ms) => (dayKey(ms) === dayKey(Date.now()) ? clock(ms) : `${fmtShort.format(ms)}, ${clock(ms)}`);
const stamp = (ms, text, title) => h("time", { datetime: new Date(ms).toISOString(), title: title ?? fmtFull.format(ms) }, text ?? when(ms));

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
const size = (bytes) => (bytes < 1024 ? plural(bytes, "byte") : `${(bytes / 1024).toFixed(1)} KB`);
const took = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// ---- data ----

function takeToken() {
  const m = /^#token=([A-Za-z0-9_-]{20,})$/.exec(location.hash);
  if (m) {
    state.token = m[1];
    try {
      sessionStorage.setItem(TOKEN_KEY, m[1]);
    } catch {}
    history.replaceState(null, "", "/#/");
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

const ID = "[A-Za-z0-9_-]{16,64}";
const ROUTES = [
  [new RegExp(`^t/(${ID})$`), (m) => ({ view: "thread", id: m[1], path: `/api/threads/${m[1]}` })],
  [new RegExp(`^t/(${ID})/c/(${ID})$`), (m) => ({ view: "proposal", id: m[1], pid: m[2], path: `/api/threads/${m[1]}/contracts/${m[2]}` })],
  [/^desk\/([a-z0-9][a-z0-9._-]{0,31})\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/, (m) => ({ view: "file", contact: m[1], name: m[2], path: `/api/frontdesk/bundles/${m[1]}/${m[2]}` })],
  [/^desk$/, () => ({ view: "desk", path: "/api/frontdesk" })],
];

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  for (const [re, make] of ROUTES) {
    const m = re.exec(hash);
    if (m) return make(m);
  }
  if (["needs", "threads", "contacts", "refused", "me"].includes(hash)) return { view: hash };
  // With nothing named, open on what is waiting for the owner, if anything is.
  return { view: state.overview?.needs.length ? "needs" : "threads" };
}

const threadHref = (id) => `#/t/${encodeURIComponent(id)}`;
const proposalHref = (id, pid) => `#/t/${encodeURIComponent(id)}/c/${encodeURIComponent(pid)}`;
const fileHref = (contact, name) => `#/desk/${encodeURIComponent(contact)}/${encodeURIComponent(name)}`;

async function refresh() {
  if (!state.token) {
    state.problem = "key";
    return paint();
  }
  try {
    const overview = await api("/api/overview");
    if (overview) state.overview = overview;
    const r = route();
    if (r.path) {
      const answer = await api(r.path);
      if (answer !== undefined) state.data.set(r.path, answer);
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

// ---- shared pieces ----

const code = (text) => h("code", null, text);
const empty = (title, ...lines) => h("div", { class: "empty" }, h("p", { class: "empty-title" }, title), lines.map((l) => h("p", null, l)));
const page = (title, lead, ...body) => [h("header", { class: "page-head" }, h("h1", null, title), lead && h("p", { class: "lead" }, lead)), ...body];
const crumb = (...steps) => h("p", { class: "crumb" }, steps.flatMap((s, i) => (i ? [h("span", { "aria-hidden": "true" }, " / "), s] : [s])));
const sideOf = (mine, contact) => (mine ? "your side" : `${contact}'s side`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sideStarts = (mine, contact) => (mine ? "Your side" : `${contact}'s side`);

// A command for the owner to run themselves. Selecting any part selects all of it.
const command = (text) => h("p", { class: "cmd" }, text);

const STATUS = { open: "Open", agreed: "Agreed", declined: "Declined", withdrawn: "Withdrawn", superseded: "Superseded" };

function signedBy(p, contact) {
  if (p.approvedByMe && p.approvedByThem) return `You and ${contact}`;
  if (p.approvedByMe) return "You";
  if (p.approvedByThem) return contact;
  return "Nobody yet";
}

const needsSignature = (p) => p.status === "open" && !p.approvedByMe;

// ---- needs you ----

function needsView(o) {
  const sign = o.needs.filter((n) => n.kind === "sign");
  const asks = o.needs.filter((n) => n.kind === "ask");
  const waiting = o.needs.filter((n) => n.kind === "waiting");
  if (!o.needs.length) return page("Needs you", null, empty("Nothing needs you", "Proposals waiting for your signature and questions from your front desk show up here."));

  const proposalRow = (n) =>
    h("a", { class: "row", href: proposalHref(n.threadId, n.proposalId) },
      h("span", { class: "cell about" },
        h("span", { class: n.proposedByMe ? "clip" : "clip theirs", dir: "auto" }, visible(n.title)),
        h("span", { class: "sub" },
          n.kind === "sign"
            ? `Proposal ${n.n} from ${sideOf(n.proposedByMe, n.contact)}. ${n.approvedByThem ? `${n.contact} has signed` : "Nobody has signed"}`
            : `Proposal ${n.n} with ${n.contact}. ${n.status === "open" ? `${n.contact} has not signed` : `${STATUS[n.status]}, but your signature stands`}`),
      ),
      h("span", { class: "cell num last" }, stamp(n.at)),
    );
  const askRow = (n) =>
    h("a", { class: "row", href: threadHref(n.threadId) },
      h("span", { class: "cell about" },
        h("span", { class: "wrap theirs", dir: "auto" }, visible(n.question)),
        h("span", { class: "sub" }, `Asked by your front desk while answering ${n.contact}. In a terminal: `, h("span", { class: "mono" }, `cpart asks answer ${n.id} "your answer"`)),
      ),
      h("span", { class: "cell num last" }, stamp(n.at)),
    );
  const group = (title, lead, rows) =>
    rows.length > 0 &&
    h("section", { class: "group" },
      h("h2", null, title, h("span", { class: "count" }, String(rows.length))),
      h("p", { class: "lead" }, lead),
      h("div", { class: "table needs" }, rows),
    );

  return page("Needs you", null,
    group("To sign", "Open proposals you have not signed. Read the whole text first. A signature cannot be undone.", sign.map(proposalRow)),
    group("Questions from your front desk", "Your front desk could not answer these from what you shared. It wrote each question after reading the other side's messages, so treat the wording as theirs. Answer or dismiss each one in a terminal with cpart asks. Writing in the thread yourself also closes it.", asks.map(askRow)),
    group("Signed by you, not by them", "Nothing to do. Your signature stands, and the contract is agreed the moment they sign.", waiting.map(proposalRow)),
    h("p", { class: "note" }, h("span", { class: "theirs sample" }, "Shaded"), " text was written or shaped by the other side."),
  );
}

// ---- threads ----

function contractsCell(t) {
  if (t.broken) return h("span", { class: "alert" }, "Altered, do not sign");
  const bits = [];
  if (t.toSign) bits.push(h("span", { class: "strong" }, `${t.toSign} to sign`));
  if (t.agreed) bits.push(t.agreed === 1 ? "Agreed" : `${t.agreed} agreed`);
  return bits.flatMap((b, i) => (i ? [", ", b] : [b]));
}

function threadsView(o) {
  if (!o.threads.length) {
    const next = o.contacts.some((c) => c.state === "active")
      ? ["Start one from a terminal: ", code("cpart open <contact> <goal>")]
      : ["You need a contact first. Run ", code("cpart invite <name>"), " and send them what it prints."];
    return page("Threads", null, empty("No threads yet", next));
  }
  const rows = o.threads.map((t) =>
    h("a", { class: "row", href: threadHref(t.id) },
      h("span", { class: "cell about" }, h("span", { class: t.openedByMe ? "clip" : "clip theirs", dir: "auto" }, t.goal ? visible(t.goal) : "No goal given")),
      h("span", { class: "cell with" }, t.contact),
      h("span", { class: "cell contracts" }, contractsCell(t)),
      h("span", { class: "cell num events" }, String(t.events), h("span", { class: "unit" }, t.events === 1 ? " event" : " events")),
      h("span", { class: "cell num last" }, stamp(t.lastAt)),
    ),
  );
  const anyTheirs = o.threads.some((t) => !t.openedByMe);
  return page("Threads", null,
    h("div", { class: "table threads" },
      h("div", { class: "thead" }, h("span", null, "Goal"), h("span", null, "With"), h("span", null, "Contracts"), h("span", { class: "num" }, "Events"), h("span", { class: "num" }, "Last activity")),
      rows,
    ),
    anyTheirs && h("p", { class: "note" }, h("span", { class: "theirs sample" }, "Shaded"), " goals were written by the other side."),
  );
}

// ---- one thread ----

function turn(e, contact, prev) {
  const mine = e.mine;
  const held = e.status === "pending";
  const desk = e.via === "frontdesk";
  const cont = prev && prev.mine === mine && prev.status === e.status && (prev.via === "frontdesk") === desk && dayKey(prev.createdAt) === dayKey(e.createdAt);
  const title = mine ? `Sent ${fmtFull.format(e.createdAt)}` : `Sent ${fmtFull.format(e.createdAt)} by their clock. Arrived ${fmtFull.format(e.receivedAt)}`;
  const body = e.text === null ? h("span", { class: "kind" }, e.type) : visible(e.text);
  return h("li", { class: `turn ${mine ? "mine" : "theirs-turn"}${cont ? " cont" : ""}${held ? " held" : ""}`, "data-id": e.id },
    h("div", { class: "who" },
      h("span", { class: "name" }, mine ? (desk ? "Your front desk" : "You") : contact),
      stamp(e.createdAt, clock(e.createdAt), title),
      desk && !mine && h("span", { class: "flag", title: `${contact}'s side says its front desk wrote this. That is their claim. This machine cannot check it.` }, "says front desk"),
      held && h("span", { class: "flag" }, "held"),
    ),
    h("div", { class: mine ? "said" : "said theirs", dir: "auto" }, body),
  );
}

const ACTS = {
  "contract.proposed": (who) => `${who.side} proposed`,
  "contract.accepted": (who) => `${who.person} signed`,
  "contract.declined": (who) => `${who.side} declined`,
  "contract.withdrawn": (who) => `${who.side} withdrew`,
  "evidence.posted": (who) => `${who.side} sent evidence for`,
};

// A contract event: one quiet line that leads to the proposal.
function act(e, t, proposals) {
  const p = proposals?.find((x) => x.proposalId === e.proposalId);
  const who = { side: sideStarts(e.mine, t.contact), person: e.mine ? "You" : t.contact };
  const title = e.mine ? `Sent ${fmtFull.format(e.createdAt)}` : `Sent ${fmtFull.format(e.createdAt)} by their clock. Arrived ${fmtFull.format(e.receivedAt)}`;
  return h("li", { class: "act", "data-id": e.id },
    h("div", { class: "who" }, stamp(e.createdAt, clock(e.createdAt), title)),
    h("div", { class: "act-body" },
      h("p", { class: "act-line" },
        h("span", { class: "act-what" }, `${ACTS[e.type](who)} `, p ? h("a", { class: "ref", href: proposalHref(t.id, p.proposalId) }, `proposal ${p.n}`) : "a proposal"),
        p && h("span", { class: p.proposedByMe ? "clip" : "clip theirs", dir: "auto" }, visible(p.title)),
      ),
      e.type === "contract.declined" && e.text !== null &&
        h("p", { class: "act-reason" }, h("span", { class: "act-what" }, `Reason from ${sideOf(e.mine, t.contact)}`), h("span", { class: e.mine ? "wrap" : "wrap theirs", dir: "auto" }, visible(e.text))),
    ),
  );
}

function proposalsBlock(t, proposals) {
  if (proposals === null) {
    return h("section", { class: "group" },
      h("h2", null, "Proposals"),
      h("p", { class: "alert" }, "A proposal stored for this thread no longer matches its hash. The local database has been altered. Do not sign anything in this thread."),
    );
  }
  if (!proposals.length) return null;
  const numberOf = (id) => proposals.find((x) => x.proposalId === id)?.n;
  return h("section", { class: "group" },
    h("h2", null, "Proposals", h("span", { class: "count" }, String(proposals.length))),
    h("div", { class: "table proposals" },
      h("div", { class: "thead" }, h("span", { class: "num" }, "No."), h("span", null, "Title"), h("span", null, "Status"), h("span", null, "Signed by"), h("span", { class: "num" }, "Proposed")),
      proposals.map((p) =>
        h("a", { class: "row", href: proposalHref(t.id, p.proposalId) },
          h("span", { class: "cell num no" }, String(p.n)),
          h("span", { class: "cell about" },
            h("span", { class: p.proposedByMe ? "clip" : "clip theirs", dir: "auto" }, visible(p.title)),
            h("span", { class: "sub" }, `From ${sideOf(p.proposedByMe, t.contact)}${p.supersedes ? `, replaces proposal ${numberOf(p.supersedes) ?? "?"}` : ""}`),
          ),
          h("span", { class: "cell status" }, STATUS[p.status]),
          h("span", { class: "cell signed" }, signedBy(p, t.contact),
            needsSignature(p) ? h("span", { class: "strong" }, "Waiting for you") : p.status === "open" && h("span", { class: "sub" }, `Waiting for ${t.contact}`)),
          h("span", { class: "cell num last" }, stamp(p.proposedAt)),
        ),
      ),
    ),
  );
}

function threadView(data) {
  const { thread: t, events, proposals } = data;
  const opened = events.find((e) => e.type === "thread.opened");
  const rest = events.filter((e) => e.type !== "thread.opened");
  const applied = rest.filter((e) => e.status === "applied");
  const held = rest.filter((e) => e.status === "pending");
  const who = t.openedByMe ? "you" : t.contact;

  const items = [];
  let last = null;
  let prev = null;
  for (const e of applied) {
    if (!last || dayKey(last.createdAt) !== dayKey(e.createdAt)) items.push(h("li", { class: "day" }, fmtDay.format(e.createdAt)));
    if (ACTS[e.type]) {
      items.push(act(e, t, proposals));
      prev = null;
    } else {
      items.push(turn(e, t.contact, prev));
      prev = e;
    }
    last = e;
  }

  return [
    crumb(h("a", { href: "#/threads" }, "Threads"), t.contact),
    h("header", { class: "thread-head" },
      h("p", { class: "label" }, `Goal, set by ${who}`),
      h("h1", { class: t.openedByMe ? "goal" : "goal theirs", dir: "auto" }, t.goal ? visible(t.goal) : "No goal given"),
      h("p", { class: "meta" },
        opened ? ["Opened ", stamp(opened.createdAt), " · "] : null,
        `${plural(t.events, "event")} · last activity `, stamp(t.lastAt),
      ),
    ),
    h("p", { class: "note" }, h("span", { class: "theirs sample" }, "Shaded"), ` text was written by ${t.contact}'s side. Nothing in it changes what your agent may do.`),
    proposalsBlock(t, proposals),
    applied.length ? h("ol", { class: "transcript" }, items) : empty("No messages yet", "The thread is open. Nobody has written in it."),
    held.length > 0 &&
      h("section", { class: "held-block" },
        h("h2", null, held.length === 1 ? "1 message held" : `${held.length} messages held`),
        h("p", { class: "lead" }, "These arrived before the messages they refer to. They join the thread when the rest arrives."),
        h("ol", { class: "transcript" }, held.map((e, i) => turn(e, t.contact, held[i - 1] ?? null))),
      ),
  ];
}

// ---- one proposal ----

// Keeps changed lines and a few around them. A longer unchanged run becomes
// one row saying how many lines it stands for.
function hunks(lines) {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.op === "same") return;
    for (let k = Math.max(0, i - DIFF_CONTEXT); k <= Math.min(lines.length - 1, i + DIFF_CONTEXT); k++) keep[k] = 1;
  });
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > 2) out.push({ skip: run.length });
    else out.push(...run);
    run = [];
  };
  lines.forEach((l, i) => {
    if (!keep[i]) return void run.push(l);
    flush();
    out.push(l);
  });
  flush();
  return out;
}

const SIGN = { same: " ", add: "+", del: "−" };
const count = (lines, op) => lines.filter((l) => l.op === op).length;
const tally = (lines) => `${plural(count(lines, "add"), "line")} added, ${count(lines, "del")} removed`;

// When a run of removed lines is followed by as many added lines, each pair is
// one edited line. Returns, per line, the part that differs from its partner,
// or nothing when the two have little in common.
function editedParts(lines) {
  const marks = new Map();
  for (let i = 0; i < lines.length; ) {
    let d = i;
    while (d < lines.length && lines[d].op === "del") d++;
    let a = d;
    while (a < lines.length && lines[a].op === "add") a++;
    if (d > i && a - d === d - i) {
      for (let k = 0; k < d - i; k++) {
        const x = Array.from(lines[i + k].text);
        const y = Array.from(lines[d + k].text);
        let s = 0;
        while (s < x.length && s < y.length && x[s] === y[s]) s++;
        let e = 0;
        while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
        if (s + e < Math.min(x.length, y.length) / 2) continue;
        marks.set(lines[i + k], [x.slice(0, s), x.slice(s, x.length - e), x.slice(x.length - e)]);
        marks.set(lines[d + k], [y.slice(0, s), y.slice(s, y.length - e), y.slice(y.length - e)]);
      }
    }
    i = Math.max(a, i + 1);
  }
  return marks;
}

function diffBlock(lines) {
  const marks = editedParts(lines);
  const text = (l) => {
    const m = marks.get(l);
    if (!m) return visible(l.text);
    const [head, mid, tail] = m.map((chars) => chars.join(""));
    return [visible(head), mid && h("span", { class: "hl" }, visible(mid)), visible(tail)];
  };
  return h("div", { class: "diff", role: "group", "aria-label": "Line by line changes" },
    hunks(lines).map((l) =>
      l.skip
        ? h("div", { class: "dl skip" }, h("span", { class: "skip-text" }, plural(l.skip, "unchanged line")))
        : h("div", { class: `dl ${l.op}` },
            h("span", { class: "ln a", "aria-hidden": "true" }, l.a ?? ""),
            h("span", { class: "ln b", "aria-hidden": "true" }, l.b ?? ""),
            h("span", { class: "sign", "aria-label": l.op === "add" ? "added" : l.op === "del" ? "removed" : undefined }, SIGN[l.op]),
            h("span", { class: "dt", dir: "auto" }, text(l)),
          ),
    ),
  );
}

function changesSection(d) {
  const { thread: t, proposal: p, previous, diff } = d;
  if (!previous || !diff) return null;
  const earlier = h("a", { class: "ref", href: proposalHref(t.id, previous.proposalId) }, `proposal ${previous.n}`);
  const textChanged = diff.text.some((l) => l.op !== "same");
  const partNote = {
    added: "Added. The earlier proposal did not have this attachment. It is shown in full below.",
    removed: "Removed. The earlier proposal had this attachment and this one does not.",
  };
  const PART = { added: "Added", removed: "Removed", same: "Unchanged", changed: "Changed" };
  const row = (name, what, quiet) => [h("dt", null, name), h("dd", { class: quiet ? "quiet" : undefined }, what)];
  return h("section", { class: "part", id: "changes" },
    h("h2", null, "What changed"),
    h("p", { class: "lead" }, "Compared line by line with ", earlier, `, from ${sideOf(previous.proposedByMe, t.contact)}. Lines marked − were taken out. Lines marked + were put in. This is a reading aid: what you sign is the full text below.`),
    h("dl", { class: "facts wide summary" },
      row("Title", previous.titleWas === null ? "Unchanged" : "Changed", previous.titleWas === null),
      row("Text", textChanged ? cap(tally(diff.text)) : "Unchanged", !textChanged),
      diff.parts.map((part) => row(h("span", { class: "mono" }, part.name), part.lines ? cap(tally(part.lines)) : PART[part.change], part.change === "same")),
    ),
    previous.titleWas !== null &&
      h("div", { class: "change" },
        h("h3", null, "Title", h("span", { class: "sub" }, "changed")),
        h("div", { class: "diff plain" },
          h("div", { class: "dl del" }, h("span", { class: "sign" }, SIGN.del), h("span", { class: "dt", dir: "auto" }, visible(previous.titleWas))),
          h("div", { class: "dl add" }, h("span", { class: "sign" }, SIGN.add), h("span", { class: "dt", dir: "auto" }, visible(p.title))),
        ),
      ),
    textChanged &&
      h("div", { class: "change" },
        h("h3", null, "Text", h("span", { class: "sub" }, tally(diff.text))),
        diffBlock(diff.text),
      ),
    diff.parts.filter((part) => part.change !== "same").map((part) =>
      h("div", { class: "change" },
        h("h3", null, h("span", { class: "mono lead-name" }, part.name), h("span", { class: "sub" }, part.lines ? tally(part.lines) : part.change)),
        part.kindWas !== null && h("p", { class: "change-note" }, `Its kind changed from ${part.kindWas} to ${p.parts.find((x) => x.name === part.name)?.kind}.`),
        part.lines ? diffBlock(part.lines) : part.change !== "changed" && h("p", { class: "change-note" }, partNote[part.change]),
      ),
    ),
  );
}

function verdict(d) {
  const { thread: t, proposal: p } = d;
  const c = t.contact;
  if (p.status === "agreed") return `Agreed. You and ${c} both signed this exact text.`;
  if (p.status === "open") return p.approvedByMe ? `Open. You have signed. ${c} has not.` : `Open. ${p.approvedByThem ? `${c} has signed` : "Nobody has signed"}. You have not.`;
  const standing = p.approvedByMe && !p.approvedByThem ? ` You signed it, and that signature stands: if ${c} signs, the contract is agreed.` : "";
  const next = d.proposals.filter((x) => p.replacedBy.includes(x.proposalId));
  const replaced = next.length > 0 && [" Replaced by ", next.flatMap((x, i) => [i ? " and " : "", h("a", { class: "ref", href: proposalHref(t.id, x.proposalId) }, `proposal ${x.n}`)]), ". This is the old text."];
  const first =
    p.status === "withdrawn" ? `Withdrawn by ${sideOf(p.proposedByMe, c)}.`
    : p.status === "declined" ? `Declined by ${p.declinedBy.map((x) => (x === "me" ? "your side" : `${c}'s side`)).filter((x, i, all) => all.indexOf(x) === i).join(" and ")}.`
    : "No longer open.";
  return [first, replaced, standing];
}

function signatures(d) {
  const { thread: t, proposal: p, canSign } = d;
  const c = t.contact;
  // An id may begin with a dash. The double dash keeps the shell command from reading it as an option.
  const dashed = t.id.startsWith("-") || p.proposalId.startsWith("-");
  const ids = `${t.id} ${p.proposalId}`;
  const line = (who, signed, at, arrived) =>
    h("div", { class: "sig" },
      h("dt", null, who),
      h("dd", { class: signed ? "signed" : "unsigned" }, !signed ? "Not signed" : at === null ? "Signed" : [arrived ? "Signed. Arrived here " : "Signed ", stamp(at)]),
    );

  let next;
  if (p.status === "agreed") {
    next = [
      h("p", null, `Both people signed this exact text. To save the contract with both signatures as a file:`),
      command(dashed ? `cpart agreement export --out agreement.json -- ${ids}` : `cpart agreement export ${ids} --out agreement.json`),
      h("p", { class: "fine" }, "Anyone can check that file with ", code("cpart agreement verify agreement.json"), ". It proves two keys approved this text. It does not prove whose keys they are."),
    ];
  } else if (p.approvedByMe) {
    next = [h("p", null, `You have signed. That cannot be undone or withdrawn. If ${c} signs this proposal, the contract is agreed.`)];
  } else if (!canSign) {
    next = [h("p", null, "This identity was made without a passphrase, so it cannot approve contracts. To sign agreements, create an identity with a passphrase.")];
  } else {
    next = [
      p.replacedBy.length > 0 && h("p", { class: "alert" }, "A newer proposal replaces this one. Signing this would approve the old text."),
      p.withdrawn && h("p", { class: "alert" }, "This proposal was withdrawn. Your signature would still count if the other side also signs."),
      p.status === "declined" && h("p", { class: "alert" }, "This proposal was declined. Your signature would still count if the other side also signs."),
      h("p", null, "To sign, run this in a terminal:"),
      command(`cpart approve ${dashed ? "-- " : ""}${ids}`),
      h("p", { class: "fine" }, "The command shows this text again and asks for your passphrase. Approving cannot be undone or withdrawn. This page never signs anything and never asks for a passphrase."),
    ];
  }
  return h("section", { class: "part", id: "signatures" },
    h("h2", null, "Signatures"),
    h("dl", { class: "sigs" }, line("You", p.approvedByMe, p.signedByMeAt, false), line(c, p.approvedByThem, p.signedByThemAt, true)),
    h("div", { class: "next" }, next),
  );
}

// ---- evidence ----

const CHANGED = { head: "head", base: "base", bindings: "bindings", policy: "trust policy" };
const short = (hex) => h("span", { class: "mono", title: hex }, hex.slice(0, 16));

// Words the other side chose. Shaded like all their text, and never a link:
// an address is shown for the owner to read, not for this page to open.
const claimed = (text, mine) => h("span", { class: mine ? "wrap mono" : "wrap theirs mono", dir: "ltr" }, visible(text));

function partCheck(p, mine) {
  const at = [" at ", claimed(p.path, mine)];
  if (p.check === "match") return h("dd", null, "The digest sent is the signed part's: sha256 ", short(p.sha256), at);
  if (p.check === "mismatch") return h("dd", { class: "alert" }, "Not the signed part. Sent sha256 ", short(p.sha256), ", signed sha256 ", short(p.signedSha256), at);
  if (p.check === "missing") return h("dd", { class: "alert" }, "The sender reports no file", at);
  return h("dd", { class: "alert" }, "The signed contract has no part with this name");
}

function evidenceOne(v, c) {
  const k = v.claim;
  return [
    h("p", { class: "label" }, "Checked here against the signed contract"),
    h("dl", { class: "facts wide" },
      h("dt", null, "Agreement"),
      v.checked.agreed ? h("dd", null, "Names this proposal and the contract hash both of you signed") : h("dd", { class: "alert" }, "Does not name an agreed proposal of this thread"),
      v.checked.parts.map((p) => [h("dt", { class: "mono" }, p.part), partCheck(p, v.mine)]),
      v.checked.unreported.map((n) => [h("dt", { class: "mono" }, n), h("dd", { class: "quiet" }, "Signed, but this evidence says nothing about it")]),
      h("dt", null, "Verifier"),
      h("dd", { class: v.checked.verifier === "same" ? null : "alert" },
        v.checked.verifier === "same" ? "The one this install ships: " : "Not the one this install ships: ", `version ${k.verifier.version}, sha256 `, short(k.verifier.sha256)),
    ),
    h("p", { class: "label" }, v.mine ? "What you told them, read from your repository" : `${c}'s claim, not checked here`),
    h("dl", { class: "facts wide" },
      h("dt", null, "Repository"), h("dd", null, claimed(k.repo, v.mine)),
      k.pr && [h("dt", null, "Pull request"), h("dd", null, claimed(k.pr, v.mine))],
      h("dt", null, "Head commit"), h("dd", { class: "mono" }, k.head),
      h("dt", null, "Base commit"), h("dd", { class: "mono" }, k.base),
      h("dt", null, "Bindings"), h("dd", null, "sha256 ", short(k.bindingsHash)),
      h("dt", null, "Trust policy"), h("dd", null, "sha256 ", short(k.trustPolicyHash)),
      h("dt", null, v.mine ? "Your result" : "Their result"), h("dd", null, k.parts.map((p, i) => [i ? ", " : "", h("span", { class: "mono" }, p.part), p.ok ? " ok" : " failed"])),
      h("dt", null, "CI run"), h("dd", null, k.run ? [k.run.status === "success" ? "Success " : "Failure ", claimed(k.run.url, v.mine)] : h("span", { class: "quiet" }, "Not given")),
    ),
  ];
}

function evidenceSide(list, mine, c) {
  const current = list.find((v) => v.state === "current");
  if (!current) return null;
  const older = list.filter((v) => v !== current).reverse();
  return h("div", { class: "evidence-side" },
    h("h3", null, mine ? "From your side" : `From ${c}'s side`, h("span", { class: "sub" }, mine ? "Sent " : "Arrived ", stamp(current.at))),
    evidenceOne(current, c),
    older.length > 0 &&
      h("div", { class: "older" },
        h("p", { class: "label" }, `${plural(older.length, "earlier report")}, no longer current`),
        h("ul", null, older.map((v) =>
          h("li", null,
            v.state === "stale" ? `Stale: ${v.changed.map((x) => CHANGED[x]).join(", ")} changed since. ` : "Replaced by a newer report for the same commits. ",
            "Head ", h("span", { class: "mono" }, v.claim.head.slice(0, 12)), mine ? ", sent " : ", arrived ", stamp(v.at),
            v.checked.partsMatch ? ". Its digests matched the signed parts." : ". Its digests did not match the signed parts.",
          ))),
      ),
  );
}

function evidenceSection(d) {
  const { thread: t, proposal: p, evidence } = d;
  if (p.status !== "agreed" && evidence.length === 0) return null;
  const theirs = evidence.filter((v) => !v.mine);
  const mine = evidence.filter((v) => v.mine);
  const dashed = t.id.startsWith("-") || p.proposalId.startsWith("-");
  return h("section", { class: "part", id: "evidence" },
    h("h2", null, "Evidence"),
    h("p", { class: "lead" }, `What each side says its repository holds for this agreement. This machine compares what it can with the contract you both signed. Everything else is the sender's word. A matching digest shows they named the right bytes. It does not show their repository holds them.`),
    theirs.length ? evidenceSide(theirs, false, t.contact) : h("p", { class: "note" }, `Nothing from ${t.contact}'s side yet.`),
    mine.length
      ? evidenceSide(mine, true, t.contact)
      : h("div", { class: "next" },
          h("p", null, "You have sent none. After you publish, run this in your repository:"),
          command(dashed ? `cpart evidence send --repo . -- ${t.id} ${p.proposalId}` : `cpart evidence send ${t.id} ${p.proposalId} --repo .`),
        ),
  );
}

const KINDS = { text: "text", "json-schema": "JSON Schema", openapi: "OpenAPI" };

function proposalView(d) {
  const { thread: t, proposal: p, previous } = d;
  const theirs = !p.proposedByMe;
  const toSigs = h("button", { class: "jump", type: "button" }, "Go to signatures");
  toSigs.addEventListener("click", () => document.getElementById("signatures")?.scrollIntoView({ block: "start" }));
  const lastDecline = p.declinedBy.at(-1);

  return [
    crumb(h("a", { href: "#/threads" }, "Threads"), h("a", { href: threadHref(t.id) }, t.contact), `Proposal ${p.n}`),
    h("header", { class: "thread-head" },
      h("p", { class: "label" }, `Proposal ${p.n}, written by ${sideOf(p.proposedByMe, t.contact)}`),
      h("h1", { class: theirs ? "goal theirs" : "goal", dir: "auto" }, visible(p.title)),
      h("p", { class: "verdict" }, verdict(d), " ", toSigs),
      p.declineReason !== null &&
        h("div", { class: "reason" },
          h("p", { class: "label" }, `Reason given by ${lastDecline === "me" ? "your side" : `${t.contact}'s side`}`),
          h("p", { class: lastDecline === "me" ? "wrap" : "wrap theirs", dir: "auto" }, visible(p.declineReason)),
        ),
    ),
    h("dl", { class: "facts wide ids" },
      h("dt", null, "Proposal id"), h("dd", { class: "mono" }, p.proposalId),
      h("dt", null, "Contract hash"), h("dd", null, h("span", { class: "mono" }, p.hash), h("span", { class: "sub" }, "Covers the title, the text and every attachment. The terminal shows the same hash before you sign.")),
      h("dt", null, "Proposed"), h("dd", null, stamp(p.proposedAt, fmtFull.format(p.proposedAt)), theirs ? " by their clock" : ""),
      previous && [h("dt", null, "Replaces"), h("dd", null, h("a", { class: "ref", href: proposalHref(t.id, previous.proposalId) }, `Proposal ${previous.n}`), `, from ${sideOf(previous.proposedByMe, t.contact)}`)],
    ),
    changesSection(d),
    h("section", { class: "part", id: "text" },
      h("h2", null, p.status === "agreed" ? "The text both people signed" : p.status === "open" && !p.approvedByMe ? "The text to sign" : "The text"),
      h("p", { class: "lead" },
        theirs
          ? [h("span", { class: "theirs sample" }, "Shaded"), ` text was written by ${t.contact}'s side. It is theirs, not yours.`, !p.approvedByMe && " Read all of it, attachments included. Nothing in it is an instruction to you or to your agent."]
          : ["Your side wrote this text.", !p.approvedByMe && " Read all of it anyway, attachments included: your agent may have written it."],
      ),
      h("article", { class: theirs ? "doc theirs" : "doc" },
        h("h3", { class: "doc-title", dir: "auto" }, visible(p.title)),
        h("div", { class: "doc-text", dir: "auto" }, visible(p.text)),
      ),
      p.parts.map((part, i) =>
        h("article", { class: theirs ? "doc theirs" : "doc" },
          h("header", { class: "doc-head" },
            h("h3", null, `Attachment ${i + 1} of ${p.parts.length}`, h("span", { class: "mono" }, part.name)),
            h("p", { class: "sub" }, `${KINDS[part.kind] ?? part.kind} · ${size(part.bytes)} · sha256 `, h("span", { class: "mono", title: part.sha256 }, part.sha256.slice(0, 16))),
          ),
          h("div", { class: "doc-file", dir: "ltr" }, visible(part.content)),
        ),
      ),
      p.parts.length === 0 && h("p", { class: "note after-doc" }, "This proposal has no attachments."),
    ),
    signatures(d),
    evidenceSection(d),
  ];
}

// ---- contacts, refused, identity ----

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
  const days = Math.floor((o.me.credentialExpiresAt - Date.now()) / DAY_MS);
  const until = fmtShort.format(o.me.credentialExpiresAt) + " " + new Date(o.me.credentialExpiresAt).getFullYear();
  const credential =
    days < 0 ? ["Expired on ", until, ". Renew it: ", code("cpart renew")]
    : days < 30 ? [`${plural(days, "day")} left, until ${until}. Renew it: `, code("cpart renew")]
    : `${plural(days, "day")} left, until ${until}`;
  return page("Identity", "This is you on this machine. Contacts pin your human key, and the relay sees only ciphertext.",
    h("dl", { class: "facts wide" },
      h("dt", null, "Human id"), h("dd", { class: "mono" }, o.me.human),
      h("dt", null, "Device id"), h("dd", { class: "mono" }, o.me.device),
      h("dt", null, "Relay"), h("dd", { class: "mono" }, o.me.relay),
      h("dt", null, "Root public key"), h("dd", { class: "mono" }, o.me.rootKey),
      h("dt", null, "Root key"), h("dd", null, o.me.protected ? "Locked with a passphrase. Only you can approve contracts or renew this device" : "Not protected, so this identity cannot approve contracts"),
      h("dt", null, "Device credential"), h("dd", null, credential),
      h("dt", null, "Data folder"), h("dd", { class: "mono" }, o.me.home),
    ),
  );
}

// ---- front desk ----

const OUTCOME = { answered: "Answered", asked_human: "Asked you", no_material: "Nothing shared", out_of_budget: "Out of replies", failed: "Failed" };

function deskView(o, data) {
  const lead = "A model with no tools that answers a contact while you are away. It sees the files you shared with that contact and nothing else.";
  if (!data.desks.length) return page("Front desk", lead, empty("No contacts yet", "The front desk is set up per contact."));

  const desks = data.desks.map((d) =>
    h("section", { class: "desk" },
      h("div", { class: "desk-head" },
        h("h2", null, d.contact),
        h("p", { class: "state" }, d.enabled ? `On, answers as ${d.owner}'s front desk` : "Off"),
      ),
      h("dl", { class: "facts" },
        h("dt", null, "Replies per thread"), h("dd", null, String(d.slotsPerThread)),
        h("dt", null, "Replies per day"), h("dd", null, String(d.slotsPerDay)),
        h("dt", null, "Shared files"),
        h("dd", null,
          d.files.length
            ? h("ul", { class: "files" }, d.files.map((f) => h("li", null, h("a", { class: "ref mono", href: fileHref(d.contact, f.name) }, f.name), h("span", { class: "sub" }, size(f.bytes)))))
            : ["None. Share one with ", code(`cpart bundle add ${d.contact} <file>`)],
        ),
      ),
    ),
  );

  const goalOf = (id) => o.threads.find((t) => t.id === id);
  const runs = data.runs.map((r) => {
    const t = goalOf(r.threadId);
    return h("div", { class: `row${r.detail ? " has-detail" : ""}` },
      h("span", { class: "cell at" }, stamp(r.at)),
      h("span", { class: "cell with" }, r.contact),
      h("span", { class: "cell about" },
        t ? h("a", { class: t.openedByMe ? "clip" : "clip theirs", href: threadHref(t.id), dir: "auto" }, t.goal ? visible(t.goal) : "No goal given") : h("span", { class: "mono" }, r.threadId),
      ),
      h("span", { class: `cell outcome${r.outcome === "failed" ? " alert" : ""}` }, OUTCOME[r.outcome] ?? r.outcome),
      h("span", { class: "cell named mono" }, r.files.length ? r.files.join(", ") : h("span", { class: "none" }, "none")),
      h("span", { class: "cell num took" }, took(r.ms)),
      r.detail && h("span", { class: "cell detail", dir: "auto" }, visible(r.detail)),
    );
  });

  return page("Front desk", lead,
    h("div", { class: "desks" }, desks),
    h("section", { class: "group" },
      h("h2", null, "Recent runs", data.runs.length > 0 && h("span", { class: "count" }, String(data.runs.length))),
      data.runs.length
        ? [
            h("p", { class: "lead" }, "Each time the front desk looked at a thread. Named files are the shared files the answer mentioned."),
            h("div", { class: "table runs" },
              h("div", { class: "thead" }, h("span", null, "When"), h("span", null, "Contact"), h("span", null, "Thread"), h("span", null, "Outcome"), h("span", null, "Named files"), h("span", { class: "num" }, "Took")),
              runs,
            ),
          ]
        : h("p", { class: "lead" }, "The front desk has not answered anything yet."),
    ),
  );
}

function fileView(f) {
  return [
    crumb(h("a", { href: "#/desk" }, "Front desk"), f.contact, f.name),
    h("header", { class: "thread-head" },
      h("p", { class: "label" }, `Shared with ${f.contact}`),
      h("h1", { class: "file-name mono" }, f.name),
      h("p", { class: "meta" }, `${size(f.bytes)} · sha256 `, h("span", { class: "mono", title: f.sha256 }, f.sha256.slice(0, 16))),
    ),
    h("p", { class: "note" }, `This is the copy your front desk reads when it answers ${f.contact}. Assume ${f.contact} can learn everything in it. To stop sharing it: `, code(`cpart bundle remove ${f.contact} ${f.name}`)),
    h("article", { class: "doc" }, h("div", { class: "doc-file", dir: "auto" }, visible(f.text))),
  ];
}

// ---- painting ----

const SECTIONS = [
  ["needs", "Needs you", (o) => o.needs.length],
  ["threads", "Threads", (o) => o.threads.length],
  ["contacts", "Contacts", (o) => o.contacts.length],
  ["desk", "Front desk", () => null],
  ["refused", "Refused", (o) => o.rejects.length],
  ["me", "Identity", () => null],
];
const PARENT = { thread: "threads", proposal: "threads", file: "desk" };

function paintNav(r) {
  const current = PARENT[r.view] ?? r.view;
  const items = SECTIONS.map(([id, label, count]) => ({ id, label, n: state.overview ? count(state.overview) : null }))
    // Nothing waiting, nothing to show. The other sections are always there.
    .filter((s) => s.id !== "needs" || s.n || current === "needs");
  const key = JSON.stringify([current, items]);
  if (key === state.renderedNav) return;
  state.renderedNav = key;
  nav.replaceChildren(
    ...items.map(({ id, label, n }) =>
      h("a", { href: `#/${id}`, class: id === "needs" ? "needs-link" : undefined, "aria-current": id === current ? "page" : undefined }, h("span", null, label), n ? h("span", { class: "count" }, String(n)) : null),
    ),
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

const DETAIL = {
  thread: {
    view: threadView,
    title: (d) => `Thread with ${d.thread.contact}`,
    missing: () => [crumb(h("a", { href: "#/threads" }, "Threads")), empty("This thread is not on this machine", "The link may be from another identity.")],
  },
  proposal: {
    view: proposalView,
    title: (d) => `Proposal ${d.proposal.n} with ${d.thread.contact}`,
    missing: (r) => [crumb(h("a", { href: "#/threads" }, "Threads"), h("a", { href: threadHref(r.id) }, "Thread")), empty("This proposal cannot be shown", "It is not in this thread on this machine, or the stored proposals no longer match their hashes.")],
  },
  desk: { view: (d) => deskView(state.overview, d), title: () => "Front desk", missing: () => [], usesOverview: true },
  file: {
    view: fileView,
    title: (d) => `${d.name}, shared with ${d.contact}`,
    missing: () => [crumb(h("a", { href: "#/desk" }, "Front desk")), empty("This file is not shared", "It may have been removed from the bundle.")],
  },
};
const LISTS = { needs: needsView, threads: threadsView, contacts: contactsView, refused: refusedView, me: meView };

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
  } else if (r.path) {
    const detail = DETAIL[r.view];
    const data = state.data.get(r.path);
    if (data === null) {
      key = `missing:${r.path}`;
      build = () => detail.missing(r);
    } else if (data === undefined) {
      key = `loading:${r.path}`;
      build = () => [];
    } else {
      key = `${r.view}:${r.path}:${state.etags.get(r.path)}:${detail.usesOverview ? state.etags.get("/api/overview") : ""}`;
      build = () => detail.view(data);
      title = `${detail.title(data)} · Counterpart`;
    }
  } else {
    key = `${r.view}:${state.etags.get("/api/overview")}:${dayKey(Date.now())}`;
    build = () => LISTS[r.view](state.overview);
    title = `${SECTIONS.find((s) => s[0] === r.view)[1]} · Counterpart`;
  }
  if (document.title !== title) document.title = title;
  if (key === state.rendered) return;

  const viewKey = `${r.view}:${r.path ?? ""}`;
  const sameView = viewKey === state.renderedView;
  state.renderedView = viewKey;
  const atBottom = sameView && r.view === "thread" && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48;
  const scrollY = window.scrollY;
  state.rendered = key;
  main.replaceChildren(...build().flat(Infinity).filter(Boolean));
  if (!sameView) window.scrollTo(0, 0);
  else if (atBottom) window.scrollTo(0, document.documentElement.scrollHeight);
  else window.scrollTo(0, scrollY);
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
