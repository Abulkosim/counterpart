# The repo verifier

`packages/verify/src/verify.mjs` is one file with no dependencies beyond Node. It answers one question about a checkout: does this tree carry what two people signed?

```sh
node verify.mjs --tree <checkout to check> --trust <trust.json from the base branch> [--json]
```

It is meant to run in CI on a pull request, from a copy of itself on the protected base branch. It reads the pull request's files as data. It never imports or runs anything from them.

## Setting it up

`cpart repo init <thread> <id> --repo . --bind <part>=<path>[,<valid dir>,<invalid dir>]` writes three files: `.counterpart/trust.json`, `.counterpart/verify.mjs` and `.github/workflows/counterpart-verify.yml`. Commit them to your main branch and protect it. The workflow is started by hand with a pull request number. It checks out main for the verifier and the trust file, fetches the pull request's files into a separate directory as data, and reports a `counterpart/verify` status on the commit it checked.

## What it checks

1. Every file in `.counterpart/agreements/` is a valid agreement: the contract matches its hash, both signatures verify, both are for the same proposal and thread.
2. The signers are exactly the two root keys in the trust file. If the trust file lists threads, the agreement is from one of them.
3. For every binding in the trust file, the agreement for the contract that binding pins is in the tree and contains that part, and the file at the bound path is byte-identical to it. An older agreement between the same two people does not count.
4. If the binding has fixtures: every file in the `valid` directory satisfies the agreed schema and every file in the `invalid` directory is rejected by it.

A missing agreement, a missing bound file or an empty fixtures directory fails. So does a symlink anywhere on a path it reads.

## The trust file

It lives on the base branch at `.counterpart/trust.json` and is passed to the verifier from there, never from the change under review. That is what stops a pull request naming its own signers or pointing a binding at a file nothing uses.

```json
{
  "v": 1,
  "parties": ["<root key>", "<root key>"],
  "threads": ["<genesis hash>"],
  "bindings": [
    {
      "part": "page.schema.json",
      "path": "schemas/page.schema.json",
      "contract": "<contract hash>",
      "fixtures": { "valid": "fixtures/page/valid", "invalid": "fixtures/page/invalid" }
    }
  ]
}
```

`parties` is sorted. `threads` is optional. Each binding names the contract it comes from, and may name the proposal too. When the two of you agree a new version, the trust file on the base branch is what changes.

## What the schema check means

The verifier supports a fixed set of JSON Schema keywords: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `anyOf`, `allOf`, `oneOf`. A schema that uses anything else, including `$ref`, `pattern` and `format`, is refused, so a schema never means more than this code checks.

Agreements, schemas and fixtures are parsed strictly: duplicate keys, a byte order mark, and integers too large to compare exactly are errors. There are limits on file size, total bytes read and the amount of checking in one run.

Passing means the fixtures in the repo satisfy the agreed constraints. It does not mean the code produces such payloads. That is what the repo's own tests are for.

## Telling the other side

`cpart evidence send <thread> <id> --repo .` reports what the verifier would see, read from committed Git objects: the head commit, the base commit (the merge base with `--base`, default `main`), the sha256 of the trust file and of `verify.mjs` on the base, the hash of the bindings, and for each binding the sha256 of the file at the bound path on the head and whether it is the signed part. `--pr`, `--run` and `--status` add a pull request and a CI run you name. `cpart pr --evidence` sends it straight after opening the pull request.

It does not read the working tree, and it does not run the verifier's fixture checks. A bound path that is a symlink or is missing is reported as no file.

`cpart evidence <thread>` shows evidence from both sides. The other side's is split in two. "Checked here" is what your machine recomputed from the contract you both signed: the part digests, the contract hash, and whether their verifier hash is the one your install ships. Everything else is their claim. A matching digest shows they named the right bytes, not that their repository holds them. When they send evidence for a new head, base, bindings or trust policy, the older one is marked stale. The format is in [protocol.md](protocol.md#evidence).

## What it does not do

It does not run tests, install packages or execute anything from the tree. It does not check that the keys belong to who you think: compare them with `cpart whoami` on each side before putting them in the trust file.
