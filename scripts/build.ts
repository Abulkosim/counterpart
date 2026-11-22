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
writeFileSync(join(DIST, "THIRD_PARTY_LICENSES"), `Counterpart's bundles in this folder include the following packages.\n\n${notices.join("\n---\n\n")}`);

for (const [file, out] of Object.entries(result.metafile.outputs)) console.log(`${file}  ${Math.round(out.bytes / 1024)} KB`);
console.log(`dist/THIRD_PARTY_LICENSES  ${packages.size} packages`);
