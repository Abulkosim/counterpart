export interface DiffLine {
  op: "same" | "add" | "del";
  text: string;
  a: number | null; // line number in the earlier text
  b: number | null; // line number in the later text
}

// The table below holds one cell per pair of lines. Both texts come from a
// peer, so its size is capped; past the cap the middle is shown as replaced.
const MAX_CELLS = 4_000_000;

// A line-level diff: the longest common subsequence of lines, after setting
// aside what the two texts share at the start and the end.
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const out: DiffLine[] = [];
  const same = (i: number, j: number): void => void out.push({ op: "same", text: a[i]!, a: i + 1, b: j + 1 });
  const del = (i: number): void => void out.push({ op: "del", text: a[i]!, a: i + 1, b: null });
  const add = (j: number): void => void out.push({ op: "add", text: b[j]!, a: null, b: j + 1 });

  for (let k = 0; k < head; k++) same(k, k);

  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n * m > MAX_CELLS) {
    for (let i = 0; i < n; i++) del(head + i);
    for (let j = 0; j < m; j++) add(head + j);
  } else {
    // lcs[i * w + j] is the length of the common subsequence of a[i..] and b[j..].
    const w = m + 1;
    const lcs = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[head + i] === b[head + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) same(head + i++, head + j++);
      else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) del(head + i++);
      else add(head + j++);
    }
    while (i < n) del(head + i++);
    while (j < m) add(head + j++);
  }

  for (let k = tail; k > 0; k--) same(a.length - k, b.length - k);
  return out;
}
