---
feature: opencode-env-and-sdk-flat
status: delivered
updated: 2026-09-30
branch: chore/opencode-leftovers-sdk-flat
commits: f40c76ac..9e025124
---

# OPENCODE leftover env rename + flatten packages/sdk/js

## Report

**What was built** — Leftover `OPENCODE_*` identifiers that are not genuine
opencode product surfaces are renamed to `MIMOCODE_*`: SDK server helpers now
write `MIMOCODE_CONFIG_CONTENT` (the name the CLI actually reads), esbuild
defines `OPENCODE_MIGRATIONS` / `OPENCODE_WORKER_PATH` / `OPENCODE_LIBC`
become `MIMOCODE_*` on both the define and `declare const` sides, and the ACP
README documents `MIMOCODE_ENABLE_QUESTION_TOOL`. Kept as-is: 
`MIMOCODE_ENABLE_OPENCODE_SKILLS`, models.dev `OPENCODE_API_KEY` fixtures, and
the deferred `OPENCODE_CALLER` reader.

`packages/sdk/js` is flattened into `packages/sdk`. The unused committed
`packages/sdk/openapi.json` snapshot is deleted (sole writer was
`script/generate.ts`; JS codegen used a private temp schema). Workspace,
tsconfig, script, and comment path tokens follow. Relative paths inside the
moved package were rewritten for the new depth, including the cwd-relative
`README_npm.md` / `LICENSE` reads in `script/publish.ts` and the stale
`build.ts` generate cwd (`../../opencode` → `../cli`). Local prefs (oxlint
local `$schema`, drop `CLAUDE.md` symlink) landed on this branch as requested.

**Verification** — From the worktree:
- `bun ci` — PASS (frozen lockfile, no changes)
- `bun typecheck` (root: all workspaces + `tsconfig.scripts.json`) — PASS
- `bun test test/ide/ide.test.ts test/config/config.test.ts` (packages/cli) — PASS (96)
- residual `OPENCODE_CONFIG_CONTENT|MIGRATIONS|WORKER_PATH|LIBC|ENABLE_QUESTION_TOOL` outside this doc — empty
- residual `packages/sdk/js` outside historical specs — empty
- remaining `OPENCODE_` hits are only keep/defer sets + models.dev fixtures
- `packages/sdk` publish paths resolve to repo-root `README_npm.md` / `LICENSE`

Independent review: C1 (publish.ts README/LICENSE one level too high) fixed to
`../../…` matching `packages/plugin/script/publish.ts`; spec S2.3.4 path math
corrected. T6 Report now names the deferred caller cleanup.

**Journey log** —
- `packages/sdk/js/script/build.ts` still pointed generate at `../../opencode`
  after the `packages/opencode` → `packages/cli` rename; the flatten's `../cli`
  silently fixes it. Full path-segment sweep found no other package-directory
  leftovers — remaining `opencode` strings are semantic (provider id, Effect
  tags, external-import source, bin name, managed config paths).
- After a one-level package flatten, cwd-relative `Bun.file("../…")` needs one
  fewer `../` than file-relative imports; `packages/plugin/script/publish.ts`
  is the depth reference.
- **Follow-up (done in a separate commit on this branch, after the rename-only
  range above):** removed `OPENCODE_CALLER` / `alreadyInstalled()`, the
  `sst-dev.opencode` install path, and unused Ide error/event surface. No in-repo
  IDE extension sets the env any more.

## [S1] Problem

Two leftover cleanup surfaces remain after the `packages/opencode` → `packages/cli`
rename and the `MIMOCODE_*` env rebrand:

1. **Stale `OPENCODE_*` identifiers** still sit in build defines, the JS SDK server
   launcher, and docs, while the runtime already reads `MIMOCODE_*`. The worst case
   is `OPENCODE_CONFIG_CONTENT` written by `@mimo-ai/sdk` server helpers while the
   CLI only loads `MIMOCODE_CONFIG_CONTENT` — programmatic config injection is a
   silent no-op.
2. **`packages/sdk` is a thin wrapper** around a nested `packages/sdk/js` workspace
   plus a 545KB committed `openapi.json`. Nothing in-repo reads that snapshot
   (`script/generate.ts` only writes it; JS codegen generates a private temp schema
   and deletes it). The extra nesting and dead artifact add path noise to every
   script, tsconfig, and lockfile token.

Local uncommitted preferences (oxlint `$schema` pointed at the local
`node_modules` copy; `CLAUDE.md` symlink to `AGENTS.md` removed) must land on this
feature branch rather than staying dirty on `main`.

## [S2] Design

### S2.1 Local prefs on the branch

Include as-is on this branch:

- `.oxlintrc.jsonc` `$schema` → `./node_modules/oxlint/configuration_schema.json`
- delete the `CLAUDE.md` → `AGENTS.md` symlink

### S2.2 Env / define rename map

| Old | New | Kind | Notes |
| --- | --- | --- | --- |
| `OPENCODE_CONFIG_CONTENT` | `MIMOCODE_CONFIG_CONTENT` | process env written by SDK | CLI already reads only `MIMOCODE_CONFIG_CONTENT` |
| `OPENCODE_MIGRATIONS` | `MIMOCODE_MIGRATIONS` | esbuild `define` + `declare const` | build.ts / build-node.ts / db.ts |
| `OPENCODE_WORKER_PATH` | `MIMOCODE_WORKER_PATH` | esbuild `define` + `declare const` | build.ts / tui/thread.ts |
| `OPENCODE_LIBC` | `MIMOCODE_LIBC` | esbuild `define` + `declare const` | build.ts / file/watcher.ts |
| `OPENCODE_ENABLE_QUESTION_TOOL` | `MIMOCODE_ENABLE_QUESTION_TOOL` | docs only | ACP README; flag already `MIMOCODE_ENABLE_QUESTION_TOOL` |

**Keep unchanged (true opencode / external data):**

- `MIMOCODE_ENABLE_OPENCODE_SKILLS` and `.opencode/skills` opt-in surface
- `OPENCODE_API_KEY` in `test/tool/fixtures/models-api.json` (models.dev provider env)

**Deferred (track, do not rename in this change):**

- `OPENCODE_CALLER` (`packages/cli/src/ide/index.ts` `alreadyInstalled()` + tests).
  No in-repo IDE extension sets it any more; the value is a stale external contract
  around `sst-dev.opencode`. Delete the reader (and the install path if still
  shipped) in a **follow-up**, not in this rename commit. Record the follow-up in
  the Report / Journey log.

No dual-read / compat shim for renamed symbols. Build defines and SDK-written env
are same-repo contracts; rename both sides in one change.

### S2.3 Flatten `packages/sdk/js` → `packages/sdk`

Only after confirming `packages/sdk/openapi.json` has no in-repo reader (true:
sole writer is `script/generate.ts`; codegen uses a temp file).

1. Delete `packages/sdk/openapi.json`.
2. Move the contents of `packages/sdk/js/` up to `packages/sdk/` (`package.json`,
   `src/`, `script/`, `example/`, `tsconfig.json`, …). Drop the empty `js/` dir.
3. Rewrite path tokens `packages/sdk/js` → `packages/sdk` in root `package.json`
   workspaces (the extra glob entry goes away; `packages/*` already covers
   `packages/sdk`), `bun.lock`, `tsconfig.json`, `tsconfig.scripts.json`,
   `script/generate.ts`, `script/publish.ts`, `AGENTS.md`, `CONTRIBUTING.md`,
   `.gitignore` (`/packages/sdk/js/openapi.json` → `/packages/sdk/openapi.json`
   for the build-temp file), and any other path-string hits outside historical
   narrative if the bulk replace is scoped to live paths.
4. Fix relative paths inside the moved package (file-relative imports need one
   more `../` than cwd-relative `Bun.file` reads after `process.chdir(pkgRoot)`):
   - `script/publish.ts` import `../../../../script/meta.ts` → `../../../script/meta.ts` (file-relative)
   - `script/publish.ts` `Bun.file("../../../README_npm.md")` / `LICENSE` → `../../…` (cwd = `packages/sdk`, match `packages/plugin/script/publish.ts`)
   - `script/tsconfig.json` extends `../../../../tsconfig.scripts.json` → `../../../tsconfig.scripts.json` (was 4 levels from `packages/sdk/js/script`; 3 levels from `packages/sdk/script`)
   - `package.json` `repository.directory` → `packages/sdk`
5. Fix the stale `build.ts` generate cwd left by the earlier rename: `path.resolve(dir, "../../opencode")` → `path.resolve(dir, "../cli")`.
6. `script/generate.ts` must stop writing `../sdk/openapi.json` (that path becomes
   the package root). Keep only the SDK codegen invocation.
7. npm name `@mimo-ai/sdk`, exports map, and public API stay identical.

### S2.4 Verification boundary

- `bun typecheck` at repo root
- focused tests: `packages/cli` ide tests (untouched behavior), any tests that
  spawn the SDK server / read `MIMOCODE_CONFIG_CONTENT`
- residual `rg 'OPENCODE_(CONFIG_CONTENT|MIGRATIONS|WORKER_PATH|LIBC|ENABLE_QUESTION)'`
  empty outside this feature doc
- residual `rg 'packages/sdk/js'` empty outside this feature doc and purely
  historical specs if left alone
- `bun ci` after lockfile path rewrite

## [S3] Out of Scope

- Deleting or renaming `OPENCODE_CALLER` (follow-up)
- Removing `sst-dev.opencode` IDE install UX
- Renaming `MIMOCODE_ENABLE_OPENCODE_SKILLS`, `.opencode` skill roots, or
  `OPENCODE_API_KEY` fixture data
- Regenerating SDK types / fixing pre-existing `@hey-api/openapi-ts` codegen breakage
- Renaming the root package `name: opencode`, binary names, or `createOpencodeServer` API

## Tasks

- [x] T1: Land local prefs on the branch (oxlint local `$schema`, drop `CLAUDE.md` symlink) — acceptance: those two diffs are committed on `chore/opencode-leftovers-sdk-flat` (covers: S2.1)
- [x] T2: Rename SDK-written `OPENCODE_CONFIG_CONTENT` → `MIMOCODE_CONFIG_CONTENT` in `packages/sdk/js/src/server.ts` and `src/v2/server.ts` — acceptance: no `OPENCODE_CONFIG_CONTENT` remains; CLI `MIMOCODE_CONFIG_CONTENT` path unchanged (covers: S2.2)
- [x] T3: Rename build-time defines `OPENCODE_MIGRATIONS` / `OPENCODE_WORKER_PATH` / `OPENCODE_LIBC` → `MIMOCODE_*` across `packages/cli/script/*.ts` and the matching `declare const` sites — acceptance: define names match declare names; no stale `OPENCODE_MIGRATIONS|WORKER_PATH|LIBC` (covers: S2.2)
- [x] T4: Fix ACP README `OPENCODE_ENABLE_QUESTION_TOOL` → `MIMOCODE_ENABLE_QUESTION_TOOL` — acceptance: docs match `Flag.MIMOCODE_ENABLE_QUESTION_TOOL` (covers: S2.2)
- [x] T5: Delete `packages/sdk/openapi.json`, flatten `packages/sdk/js/*` to `packages/sdk/*`, rewrite path tokens and in-package relatives, stop `generate.ts` writing openapi.json — acceptance: workspace installs frozen, root typecheck passes, `packages/sdk/js` gone, `@mimo-ai/sdk` resolves from `packages/sdk` (covers: S2.3; depends: T2, T3)
- [x] T6: Residual scans + record `OPENCODE_CALLER` deletion follow-up in Report — acceptance: scans match S2.4; Report/Journey names the deferred caller cleanup (covers: S2.2, S2.4; depends: T1–T5)
