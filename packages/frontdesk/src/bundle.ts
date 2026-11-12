import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// The bundle is everything the front desk model can see for one contact.
// Files are copied in when the human approves them, so later edits to the
// originals are not shared until approved again.
export interface BundleFile {
  name: string;
  text: string;
  sha256: string;
}
export interface Bundle {
  files: BundleFile[];
  bytes: number;
  hash: string; // identifies exactly what was shared
}

export const BUNDLE_LIMITS = { files: 64, bytes: 400 * 1024, fileBytes: 200 * 1024 } as const;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const dir = (home: string, contact: string): string => join(home, "bundles", contact);
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export function readBundle(home: string, contact: string): Bundle {
  const d = dir(home, contact);
  const files: BundleFile[] = [];
  if (existsSync(d)) {
    for (const name of readdirSync(d).sort()) {
      if (!NAME.test(name) || !lstatSync(join(d, name)).isFile()) continue;
      const text = readFileSync(join(d, name), "utf8");
      files.push({ name, text, sha256: sha(text) });
    }
  }
  return { files, bytes: files.reduce((n, f) => n + Buffer.byteLength(f.text), 0), hash: sha(files.map((f) => `${f.name}\0${f.sha256}\n`).join("")) };
}

export function addToBundle(home: string, contact: string, paths: string[]): Bundle {
  const d = dir(home, contact);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const incoming = paths.map((p) => {
    const st = lstatSync(p);
    if (!st.isFile()) throw new Error(`${p} is not a regular file`);
    if (st.size > BUNDLE_LIMITS.fileBytes) throw new Error(`${p} is larger than ${BUNDLE_LIMITS.fileBytes / 1024} KB`);
    const name = basename(p);
    if (!NAME.test(name)) throw new Error(`"${name}": bundle file names use letters, digits, dot, dash and underscore`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(p));
    } catch {
      throw new Error(`${p} is not UTF-8 text`);
    }
    if (text.includes("\0")) throw new Error(`${p} is not text`);
    return { name, text };
  });
  const current = readBundle(home, contact);
  const names = new Set([...current.files.map((f) => f.name), ...incoming.map((f) => f.name)]);
  const bytes = current.files.filter((f) => !incoming.some((i) => i.name === f.name)).reduce((n, f) => n + Buffer.byteLength(f.text), 0) + incoming.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
  if (names.size > BUNDLE_LIMITS.files) throw new Error(`a bundle holds at most ${BUNDLE_LIMITS.files} files`);
  if (bytes > BUNDLE_LIMITS.bytes) throw new Error(`a bundle holds at most ${BUNDLE_LIMITS.bytes / 1024} KB`);
  for (const f of incoming) writeFileSync(join(d, f.name), f.text, { mode: 0o600 });
  return readBundle(home, contact);
}

export function removeFromBundle(home: string, contact: string, name: string): Bundle {
  if (!NAME.test(name)) throw new Error(`no file "${name}" in the bundle`);
  const p = join(dir(home, contact), name);
  if (!existsSync(p)) throw new Error(`no file "${name}" in the bundle`);
  rmSync(p);
  return readBundle(home, contact);
}
