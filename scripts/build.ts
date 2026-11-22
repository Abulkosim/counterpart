// Builds dist/, the npm package. Node will not strip types from files under
// node_modules, so the package ships JavaScript: three bundles with every
// dependency inside, and the plain files the code reads at run time.
//   node scripts/build.ts
// Code that finds a file or starts a script by path checks whether it runs
// from a .ts file (a checkout) or from dist/, so these names must match it.
import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");

rmSync(DIST, { recursive: true, force: true });

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: {
    cli: "packages/cli/src/main.ts",
    // Claude Code and Codex run this on every prompt; it stays small.
    "hook-main": "packages/mcp/src/hook-main.ts",
    // frontdesk/src/offload.ts starts it as a worker thread.
    "prepare-worker": "packages/frontdesk/src/prepare-worker.ts",
  },
  outdir: DIST,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // ws loads these optional native speedups inside a try and works without them.
  external: ["bufferutil", "utf-8-validate"],
  plugins: [
    {
      // The verifier ships as one file, byte for byte, because evidence names its
      // hash. The bundles import that file instead of a copy of it.
      name: "verifier",
      setup: (b) => b.onResolve({ filter: /^@counterpart\/verify$/ }, () => ({ path: "./verify.mjs", external: true })),
    },
  ],
  // Some dependencies are CommonJS and call require() for Node's own modules.
  banner: { js: 'import { createRequire as __cpartRequire } from "node:module"; const require = __cpartRequire(import.meta.url);' },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// Files read at run time, at the paths the code expects next to the bundles.
cpSync(join(ROOT, "packages/verify/src/verify.mjs"), join(DIST, "verify.mjs"));
cpSync(join(ROOT, "packages/daemon/src/guard-data/gitleaks-rules.json"), join(DIST, "guard-data/gitleaks-rules.json"));
cpSync(join(ROOT, "packages/viewer/public"), join(DIST, "viewer"), { recursive: true });
chmodSync(join(DIST, "cli.js"), 0o755);

// Bundling copies other people's code into ours, so their license texts go with it.
const packages = new Map<string, string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
  if (m) packages.set(m[2]!, join(ROOT, m[1]!));
}
const notices = [...packages]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, dir]) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string };
    const file = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"].map((f) => join(dir, f)).find((f) => existsSync(f));
    if (!file) throw new Error(`${name} has no license file to ship`);
    return `${name}@${pkg.version} (${pkg.license ?? "see below"})\n\n${readFileSync(file, "utf8").trim()}\n`;
  });
// Data from other projects, copied in rather than bundled from node_modules.
const data = [
  `gitleaks rules (MIT): guard-data/gitleaks-rules.json holds rules converted from
gitleaks v8.30.1, config/gitleaks.toml, https://github.com/gitleaks/gitleaks

MIT License

Copyright (c) 2019 Zachary Rice

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  `EFF short wordlist 1 (CC BY 3.0 US): the pairing code words in cli.js

"EFF's Short Wordlist #1" by the Electronic Frontier Foundation (2016),
https://www.eff.org/dice, used under the Creative Commons Attribution 3.0
United States license, https://creativecommons.org/licenses/by/3.0/us/.
Changed: the word "yo-yo" is left out, because a dash separates the words of
a code.
`,
];
writeFileSync(
  join(DIST, "THIRD_PARTY_LICENSES"),
  `Counterpart's bundles in this folder include the following packages and data.\n\n${[...notices, ...data].join("\n---\n\n")}`,
);

for (const [file, out] of Object.entries(result.metafile.outputs)) console.log(`${file}  ${Math.round(out.bytes / 1024)} KB`);
console.log(`dist/THIRD_PARTY_LICENSES  ${packages.size} packages`);
