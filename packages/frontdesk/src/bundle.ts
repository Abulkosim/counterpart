import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

const BUNDLE_LIMITS = { files: 64, bytes: 400 * 1024, fileBytes: 200 * 1024 } as const;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

function dir(home: string, contact: string, create: boolean): string | null {
  const parent = join(home, "bundles");
  const d = join(parent, contact);
  if (create) mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const p of [parent, d]) {
    if (!existsSync(p)) return null;
    // A symlinked bundle directory could point the model at anything.
    if (!lstatSync(p).isDirectory()) throw new Error(`${p} must be a real directory`);
  }
  return d;
}

// Open without following a symlink and check the thing actually opened, so the
// file cannot be swapped between the check and the read.
function readText(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${path} is not a regular file`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (st.size > BUNDLE_LIMITS.fileBytes) throw new Error(`${path} is larger than ${BUNDLE_LIMITS.fileBytes / 1024} KB`);
    const bytes = readFileSync(fd);
    if (bytes.length > BUNDLE_LIMITS.fileBytes) throw new Error(`${path} is larger than ${BUNDLE_LIMITS.fileBytes / 1024} KB`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${path} is not UTF-8 text`);
    }
    if (text.includes("\0")) throw new Error(`${path} is not text`);
    return text;
  } finally {
    closeSync(fd);
  }
}

export function readBundle(home: string, contact: string): Bundle {
  const d = dir(home, contact, false);
  const files: BundleFile[] = [];
  if (d) {
    for (const name of readdirSync(d).sort()) {
      if (!NAME.test(name) || name.endsWith(".tmp")) continue;
      let text: string;
      try {
        text = readText(join(d, name));
      } catch {
        continue; // anything odd in the directory is not shared
      }
      files.push({ name, text, sha256: sha(text) });
      if (files.length >= BUNDLE_LIMITS.files) break;
    }
  }
  return { files, bytes: files.reduce((n, f) => n + Buffer.byteLength(f.text), 0), hash: sha(files.map((f) => `${f.name}\0${f.sha256}\n`).join("")) };
}

export function addToBundle(home: string, contact: string, paths: string[]): Bundle {
  const d = dir(home, contact, true)!;
  const incoming = paths.map((p) => {
    const name = basename(p);
    if (!NAME.test(name) || name.endsWith(".tmp")) throw new Error(`"${name}": bundle file names use letters, digits, dot, dash and underscore`);
    return { name, text: readText(p) };
  });
  const current = readBundle(home, contact);
  const names = new Set([...current.files.map((f) => f.name), ...incoming.map((f) => f.name)]);
  const bytes = current.files.filter((f) => !incoming.some((i) => i.name === f.name)).reduce((n, f) => n + Buffer.byteLength(f.text), 0) + incoming.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
  if (names.size > BUNDLE_LIMITS.files) throw new Error(`a bundle holds at most ${BUNDLE_LIMITS.files} files`);
  if (bytes > BUNDLE_LIMITS.bytes) throw new Error(`a bundle holds at most ${BUNDLE_LIMITS.bytes / 1024} KB`);
  for (const f of incoming) {
    // Write beside the target and rename over it: a reader sees the old file or
    // the new one, and a symlink planted at the target is replaced, not followed.
    const tmp = join(d, `${randomBytes(8).toString("hex")}.tmp`);
    writeFileSync(tmp, f.text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, join(d, f.name));
  }
  return readBundle(home, contact);
}

export function removeFromBundle(home: string, contact: string, name: string): Bundle {
  const d = dir(home, contact, false);
  if (!d || !NAME.test(name) || !existsSync(join(d, name))) throw new Error(`no file "${name}" in the bundle`);
  rmSync(join(d, name));
  return readBundle(home, contact);
}
