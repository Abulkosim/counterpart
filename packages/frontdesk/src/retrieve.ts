// Picks the parts of the shared files that matter for a question, so a share
// larger than the model's context can still be used. Files are cut into
// chunks of lines; chunks are ranked against the question with BM25, a plain
// word-overlap score that needs no model and no network; the best ones are
// taken until a fixed budget of characters is used. If everything fits, it is
// all included and nothing is ranked.

export interface Doc {
  path: string;
  text: string;
}
export interface Chunk {
  path: string;
  start: number; // first line, from 1
  end: number; // last line, inclusive
  lines: string[];
}
export interface Selection {
  chunks: Chunk[]; // in path and line order, adjacent ones merged
  ranked: boolean; // false when everything fitted
  chars: number;
}

export const RETRIEVE = { budget: 90_000, chunkLines: 40, chunkChars: 2400 } as const;

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in is it its me my of on or our so than that the their them then there these they this to us was we what when where which who why will with would you your".split(" "),
);

export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length >= 2 && !STOP.has(lower)) out.push(lower);
    // camelCase, snake_case and digits are split too, so "maxBytes" meets "max bytes".
    const parts = word.split(/_|(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/).map((p) => p.toLowerCase());
    if (parts.length > 1) for (const p of parts) if (p.length >= 2 && !STOP.has(p)) out.push(p);
  }
  return out;
}

export function chunk(doc: Doc): Chunk[] {
  const lines = doc.text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const chunks: Chunk[] = [];
  let cur: string[] = [];
  let start = 1;
  let chars = 0;
  const flush = (): void => {
    if (cur.length) chunks.push({ path: doc.path, start, end: start + cur.length - 1, lines: cur });
    start += cur.length;
    cur = [];
    chars = 0;
  };
  for (const l of lines) {
    // A Markdown heading starts a new chunk, so a section stays together.
    if (cur.length >= 6 && /^#{1,4} /.test(l)) flush();
    if (cur.length >= RETRIEVE.chunkLines || (cur.length && chars + l.length > RETRIEVE.chunkChars)) flush();
    cur.push(l.length > RETRIEVE.chunkChars ? `${l.slice(0, RETRIEVE.chunkChars)} [line cut short]` : l);
    chars += Math.min(l.length, RETRIEVE.chunkChars) + 1;
  }
  flush();
  return chunks;
}

export function render(c: Chunk): string {
  return `=== ${c.path} lines ${c.start}-${c.end} ===\n${c.lines.map((l, i) => `${c.start + i}| ${l}`).join("\n")}\n`;
}

// BM25 with k1 = 1.2 and b = 0.75. The path counts as part of every chunk of
// its file, twice, since a question often names the file or module.
function score(chunks: Chunk[], query: string): number[] {
  const q = [...new Set(tokens(query))];
  if (q.length === 0) return chunks.map(() => 0);
  const docs = chunks.map((c) => {
    const t = [...tokens(c.lines.join("\n")), ...tokens(c.path), ...tokens(c.path)];
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { tf, len: t.length };
  });
  const avg = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const w of q) df.set(w, docs.filter((d) => d.tf.has(w)).length);
  return docs.map((d) => {
    let s = 0;
    for (const w of q) {
      const f = d.tf.get(w) ?? 0;
      if (!f) continue;
      const n = df.get(w)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      s += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * d.len) / avg));
    }
    return s;
  });
}

export function select(docs: Doc[], query: string, budget: number = RETRIEVE.budget): Selection {
  const all = docs.flatMap(chunk);
  const size = all.map((c) => render(c).length);
  const total = size.reduce((a, b) => a + b, 0);
  if (total <= budget) return { chunks: merge(all), ranked: false, chars: total };
  const s = score(all, query);
  const order = all.map((_, i) => i).filter((i) => s[i]! > 0).sort((a, b) => s[b]! - s[a]! || a - b);
  const picked = new Set<number>();
  let used = 0;
  const take = (i: number): void => {
    if (i < 0 || i >= all.length || picked.has(i) || used + size[i]! > budget) return;
    picked.add(i);
    used += size[i]!;
  };
  for (const i of order) take(i);
  // Room left: the chunk after each of the best hits, where an answer often continues.
  for (const i of order.slice(0, 8)) if (all[i + 1]?.path === all[i]!.path) take(i + 1);
  return { chunks: merge([...picked].sort((a, b) => a - b).map((i) => all[i]!)), ranked: true, chars: used };
}

function merge(chunks: Chunk[]): Chunk[] {
  const out: Chunk[] = [];
  for (const c of chunks) {
    const last = out.at(-1);
    if (last && last.path === c.path && last.end + 1 === c.start) out[out.length - 1] = { ...last, end: c.end, lines: [...last.lines, ...c.lines] };
    else out.push(c);
  }
  return out;
}
