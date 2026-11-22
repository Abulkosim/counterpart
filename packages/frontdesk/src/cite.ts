// Checks a reply written from shared repository files. Every line that is
// sent must carry at least one citation, and every citation must hold: the
// file is one the contact may read, at the commit the desk read, the lines
// exist, and the quoted text is really on those lines. A line that fails any
// of this is removed before anything is sent. This proves the quote is there,
// not that the sentence around it is true; the line is kept only as a whole.

// [path:12 "quoted text"] or [path:12-18 "quoted text"]
const CITATION = /\[`?([^\s"`[\]]+?)`?:(\d{1,7})(?:-(\d{1,7}))?(?:\s+"(.*?)")?\]/g;
const SLACK = 3; // lines either side, for a model that is off by a line or two
const MAX_SPAN = 120;

export interface Citation {
  path: string;
  start: number;
  end: number;
}
export interface Checked {
  text: string; // the lines that passed, in order
  kept: number;
  removed: number;
  citations: Citation[]; // every valid citation in what is sent
  problems: string[]; // why lines were removed, for the owner's log
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

export function checkCitations(reply: string, files: Map<string, string>): Checked {
  const lines = new Map<string, string[]>();
  const fileLines = (p: string): string[] | undefined => {
    if (!lines.has(p) && files.has(p)) lines.set(p, files.get(p)!.split("\n"));
    return lines.get(p);
  };
  const kept: string[] = [];
  const citations: Citation[] = [];
  const problems: string[] = [];
  let removed = 0;
  for (const raw of reply.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const found = [...line.matchAll(CITATION)];
    if (found.length === 0) {
      removed++;
      problems.push("a line with no citation");
      continue;
    }
    const mine: Citation[] = [];
    let bad: string | null = null;
    for (const m of found) {
      const [, path, a, b, q] = m as unknown as [string, string, string, string | undefined, string | undefined];
      const start = Number(a);
      const end = b === undefined ? start : Number(b);
      const fl = fileLines(path);
      if (!fl) bad = `cited ${path.slice(0, 120)}, which is not shared`;
      else if (start < 1 || end < start || end > fl.length || end - start > MAX_SPAN) bad = `cited lines ${start}-${end} of ${path}, which has ${fl.length}`;
      else if (q === undefined) bad = `cited ${path}:${start} without a quote`;
      else {
        const quote = norm(q.replace(/\\"/g, '"').replace(/(^|\s)\d{1,7}\| /g, "$1"));
        const window = norm(fl.slice(Math.max(0, start - 1 - SLACK), end + SLACK).join("\n"));
        if (quote.replace(/\s/g, "").length < 6) bad = `quoted too little from ${path}:${start}`;
        else if (!window.includes(quote)) bad = `quoted text that is not at ${path}:${start}${end > start ? `-${end}` : ""}`;
      }
      if (bad) break;
      mine.push({ path: path!, start, end });
    }
    if (bad) {
      removed++;
      problems.push(bad);
      continue;
    }
    kept.push(line);
    citations.push(...mine);
  }
  return { text: kept.join("\n"), kept: kept.length, removed, citations, problems };
}
