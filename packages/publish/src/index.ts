import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Agreement, canonicalize, hashOf, verifyAgreement } from "@counterpart/protocol";
// @ts-expect-error the verifier is plain JavaScript so it can be copied into other repos as one file
import { verifyTree } from "@counterpart/verify";
import type { WorkResult } from "@counterpart/worker";

// Publishing is the owner acting in their own repository, with their own Git
// and GitHub login. Nothing here is given to a model. The files that tie a
// repository to an agreement (the trust file, the agreement, the verifier and
// its workflow) are written by this code and by nothing else.

const VERIFIER = join(dirname(fileURLToPath(import.meta.url)), "../../verify/src/verify.mjs");
const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

export interface Binding {
  part: string;
  path: string;
  fixtures?: { valid: string; invalid: string };
}

const WORKFLOW = `name: Counterpart verify

# Checks that a pull request carries what both people signed. It is started by
# hand for one pull request, and runs the verifier and trust file from this
# branch, never from the pull request. The pull request's files are read as
# data and nothing in them is run.
on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number
        required: true

permissions:
  contents: read
  pull-requests: read
  statuses: write

concurrency:
  group: counterpart-verify-\${{ inputs.pr }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Check the input
        env:
          PR: \${{ inputs.pr }}
        run: '[[ "$PR" =~ ^[0-9]{1,9}$ ]]'
      - name: Check out this branch (the verifier and the trust file)
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Resolve the pull request head
        id: head
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ inputs.pr }}
        run: echo "sha=$(gh api "repos/\${{ github.repository }}/pulls/$PR" --jq .head.sha)" >> "$GITHUB_OUTPUT"
      - name: Fetch the pull request's files as data
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ steps.head.outputs.sha }}
          path: under-review
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "24"
          package-manager-cache: false
      - name: Verify
        id: verify
        run: node .counterpart/verify.mjs --tree under-review --trust .counterpart/trust.json
      - name: Report on the commit that was checked
        if: always()
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ inputs.pr }}
          SHA: \${{ steps.head.outputs.sha }}
          OUTCOME: \${{ steps.verify.outcome }}
        run: |
          # If the pull request moved while this ran, the result is for an old commit and is not reported as current.
          now=$(gh api "repos/\${{ github.repository }}/pulls/$PR" --jq .head.sha)
          if [ "$now" != "$SHA" ]; then echo "The pull request changed during verification. Run this again."; exit 1; fi
          state=failure; text="Does not carry what both people signed"
          if [ "$OUTCOME" = success ]; then state=success; text="Carries what both people signed"; fi
          gh api "repos/\${{ github.repository }}/statuses/$SHA" -f state="$state" -f context="counterpart/verify" -f description="$text" -f target_url="\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}" > /dev/null
`;

function cleanRel(p: string): string {
  if (p === "" || p.startsWith("/") || /[\\:\u0000-\u001f]/.test(p) || p.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`"${p}" is not a plain path inside the repository`);
  return p;
}

function write(repo: string, rel: string, content: string | Buffer): void {
  // Never through a symlink: these files decide what the repository trusts.
  let at = repo;
  for (const part of rel.split("/").slice(0, -1)) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) throw new Error(`${rel}: a parent of this path is not a plain directory`);
  }
  const st = lstatSync(join(repo, rel), { throwIfNoEntry: false });
  if (st && !st.isFile()) throw new Error(`${rel} exists and is not a plain file`);
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}

// Write what the base branch needs so pull requests can be checked: who is
// trusted, which contract part must sit at which path, the verifier itself and
// a workflow that runs it. The owner commits these to the protected branch.
export function repoInit(repo: string, agreement: Agreement, bindings: Binding[]): string[] {
  const a = verifyAgreement(agreement);
  if (bindings.length === 0) throw new Error("name at least one binding: --bind <part>=<path>");
  for (const b of bindings) {
    if (!a.contract.parts.some((p) => p.name === b.part)) throw new Error(`the contract has no attachment named "${b.part}"`);
    cleanRel(b.path);
    if (b.fixtures) [b.fixtures.valid, b.fixtures.invalid].forEach(cleanRel);
  }
  const trust = {
    v: 1,
    parties: a.contract.parties,
    threads: [hashOf(a.genesis)],
    bindings: bindings.map((b) => ({ part: b.part, path: b.path, contract: a.contractHash, proposal: a.proposalId, ...(b.fixtures ? { fixtures: b.fixtures } : {}) })),
  };
  const files: [string, string | Buffer][] = [
    [".counterpart/trust.json", `${JSON.stringify(trust, null, 2)}\n`],
    [".counterpart/verify.mjs", readFileSync(VERIFIER)],
    [".github/workflows/counterpart-verify.yml", WORKFLOW],
  ];
  for (const [rel, content] of files) write(repo, rel, content);
  return files.map(([rel]) => rel);
}

export interface Publication {
  branch: string;
  title: string;
  body: string;
  files: string[]; // exactly what will be committed
  agreementFile: string;
  check: { ok: boolean; checks: { ok: boolean; what: string; detail: string }[] };
  remote: string;
  base: string;
}

const run = (repo: string, cmd: string, args: string[]): string => execFileSync(cmd, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Work out, without changing anything but the agreement file, what publishing
// would do, and check the result the way CI will. The owner is shown this
// before anything leaves the machine.
export function preparePublication(repo: string, agreement: Agreement, work: Pick<WorkResult, "baseCommit" | "changes" | "files">, opts: { branch?: string } = {}): Publication {
  const a = verifyAgreement(agreement);
  const head = run(repo, "git", ["rev-parse", "HEAD"]);
  if (head !== work.baseCommit) throw new Error("the repository has moved since the work was done. Run the work again.");
  // The files on disk must be exactly the reviewed work, byte for byte.
  for (const f of work.files) {
    const change = work.changes.find((c) => c.path === f.path);
    const st = lstatSync(join(repo, f.path), { throwIfNoEntry: false });
    if (!change || !st?.isFile() || sha(readFileSync(join(repo, f.path))) !== change.after) throw new Error(`${f.path} is not the reviewed work. Apply it first with cpart work apply, and do not edit it before publishing.`);
  }
  const trustBlob = (() => {
    try {
      return execFileSync("git", ["cat-file", "blob", "HEAD:.counterpart/trust.json"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new Error("this branch has no .counterpart/trust.json. Run cpart repo init and commit the result to your main branch first.");
    }
  })();
  const agreementFile = `.counterpart/agreements/${a.proposalId}.json`;
  write(repo, agreementFile, `${JSON.stringify(JSON.parse(canonicalize(agreement)), null, 2)}\n`);
  // The bound parts are written here from the signed contract, byte for byte.
  // Whatever the worker put at those paths is replaced: the link between the
  // agreement and the repository is not left to a model.
  const bound: string[] = [];
  const trust = JSON.parse(trustBlob.toString("utf8")) as { bindings?: { part: string; path: string; contract: string }[] };
  for (const b of trust.bindings ?? []) {
    const part = b.contract === a.contractHash ? a.contract.parts.find((x) => x.name === b.part) : undefined;
    if (!part) continue;
    write(repo, cleanRel(b.path), part.content);
    bound.push(b.path);
  }
  const files = [...new Set([...work.files.map((f) => f.path), agreementFile, ...bound])].sort();
  // Anything else that is modified or untracked is not part of this publication, and is named so it is not a surprise.
  const dirty = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\0")
    .filter(Boolean)
    .map((l) => l.slice(3));
  const extra = dirty.filter((p) => !files.includes(p));
  if (extra.length) throw new Error(`these files have changes that are not part of the reviewed work: ${extra.slice(0, 10).join(", ")}. Commit or put them aside first.`);

  const check = verifyTree(repo, trustBlob) as Publication["check"];
  const base = run(repo, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = run(repo, "git", ["remote", "get-url", "origin"]);
  const [x, y] = a.contract.parties as [string, string];
  const body = [
    "## Counterpart agreement",
    "",
    "This change implements a contract two people signed.",
    "",
    "| | |",
    "| --- | --- |",
    `| Contract hash | \`${a.contractHash}\` |`,
    `| Proposal | \`${a.proposalId}\` |`,
    `| Signed by | \`${x}\` |`,
    `| and | \`${y}\` |`,
    `| Agreement file | \`${agreementFile}\` |`,
    "",
    "The contract text is in the agreement file. To check that this pull request carries what was signed, run the `Counterpart verify` workflow from the default branch with this pull request's number. It reads these files as data and reports the status `counterpart/verify` on the head commit.",
    "",
    "The code itself was proposed by a model and reviewed by a person before it was committed. Review it as you would any change.",
  ].join("\n");
  return { branch: opts.branch ?? `counterpart/${a.proposalId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`, title: "feat: implement the agreed contract", body, files, agreementFile, check, remote, base };
}

// Commit exactly the listed files on a new branch, push it and open the pull
// request. Uses the owner's own Git and gh configuration on purpose.
export function publish(repo: string, p: Publication, opts: { title?: string } = {}): string {
  run(repo, "git", ["checkout", "-b", p.branch]);
  run(repo, "git", ["add", "--", ...p.files]);
  run(repo, "git", ["commit", "-m", `${opts.title ?? p.title}\n\nImplements Counterpart proposal ${p.agreementFile.split("/").pop()!.replace(".json", "")}.`, "--", ...p.files]);
  run(repo, "git", ["push", "-u", "origin", p.branch]);
  return run(repo, "gh", ["pr", "create", "--base", p.base, "--head", p.branch, "--title", opts.title ?? p.title, "--body", p.body]);
}

