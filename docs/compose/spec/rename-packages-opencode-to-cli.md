---
feature: rename-packages-opencode-to-cli
status: delivered
updated: 2026-09-30
branch: chore/rename-packages-opencode-to-cli
commits: 327f5b63..afec3965
---

# Rename packages/opencode → packages/cli

## Report

**What was built** — The core package directory is now `packages/cli`, matching the published `@mimo-ai/cli` name. Every literal `packages/opencode` path reference was rewritten: root scripts and typecheck project refs, CI `working-directory`/artifact paths, `bun.lock` workspace tokens, install/release helpers, in-package comments and prompt templates, test fixtures and snapshots, the drive-mimo skill, living docs, and all historical `docs/compose/spec/*.md`. Semantic product identifiers (provider ids, external-import source `opencode`, root package name, shared bin key, upstream GitHub URLs, shipped migration SQL) were left untouched. There is no compatibility shim.

AGENTS.md was also slimmed in the same change: `## Core Focus` is gone (tree is CLI-only after recent PRs), and Testing/Type Checking no longer teach how to run checks — only how to write tests (avoid mocks; test real implementation). CONTRIBUTING keeps its human-facing "Checks before you push" commands. Prompt templates no longer cite the deleted AGENTS how-to-run rules.

**Verification** — From `packages/cli` / repo root in the worktree:
- `bun ci` (frozen lockfile after workspace path rewrite) — PASS
- root `bun typecheck` (all workspaces + `tsconfig.scripts.json`) — PASS
- `bun test test/cli/tui/permission-bash-delete.test.tsx test/cli/run-completion.test.ts` — PASS (33)
- `bun test test/session/text-loop-integration.test.ts` — PASS (3)
- residual `rg packages/opencode` outside this feature doc — empty

Independent review: all 6 acceptance criteria met; no critical findings. Non-critical prompt-template/AGENTS drift fixed in `afec3965`. Orphan `test/tool/__snapshots__/tool.test.ts.snap` is pre-existing (no `tool.test.ts` at base).

**Journey log**
- Bulk path replace initially skipped dotted dirs (`.github`), so CI paths stayed stale until a second pass included them.
- The feature document itself was rewritten by the bulk replace twice; keep historical `packages/opencode` wording out of bulk-replace sweeps, or rewrite the doc after path sweeps.
- `bun.lock` must be path-patched before `postinstall` can run; root scripts still pointed at the old cwd and failed first `bun ci`.
- Workspace globs `packages/*` meant no `package.json` workspaces edit was needed — only lockfile path tokens.
- Prompt templates embed AGENTS-style verify rules and will drift when AGENTS.md is edited independently.

## [S1] Problem

The core package already publishes as `@mimo-ai/cli`, but its directory was still
`packages/opencode` (a historical leftover). That mismatch showed up in every
developer path: AGENTS/CONTRIBUTING examples, CI `working-directory`, root
scripts (`dev` / `build:local` / `postinstall` / release), typecheck project
refs, install helpers, and ~38 archived feature docs. New contributors and
agents kept tripping over the name. We want the on-disk path to match the package
name, with every path reference updated so nothing still points at the old
directory.

## [S2] Design

**Rename.** `git mv packages/opencode packages/cli`. Workspace globs
(`packages/*`, `packages/sdk/js`) pick up the new directory without
`package.json` workspaces edits. The published npm name stays `@mimo-ai/cli`.
The root monorepo `name` stays `opencode`.

**Path-string contract.** Replace the literal path token `packages/opencode`
with `packages/cli` everywhere it refers to this package directory. Scope
covers root scripts/config (`package.json`, `tsconfig*.json`, `local-install.sh`),
build/release scripts (`script/release.ts`, `publish.ts`, `generate.ts`,
`meta.ts`, `fds-upload.ts`), CI (`.github/workflows/test.yml`), `bun.lock`
workspace tokens, in-package path comments and prompt templates, test fixtures
and snapshots, `packages/sdk/js/src/process.ts`,
`.agents/skills/drive-mimo/SKILL.md`, living docs (`AGENTS.md`, `CONTRIBUTING.md`),
and every historical `docs/compose/spec/*.md` (user decision: rewrite to
`packages/cli`).

**AGENTS.md content cleanup** (user decision, same change):

- Drop `## Core Focus` — after recent PRs the tree is CLI-only, so the section is noise.
- Drop `## Type Checking` entirely and the "how to run tests" bullet under `## Testing` — root `typecheck` / package `test` scripts are self-explanatory.
- Keep only how-to-write-tests guidance under `## Testing` (no mocks; test real implementation).
- Leave `CONTRIBUTING.md` "Checks before you push" run commands in place (human onboarding).
- Prompt templates must not cite deleted AGENTS how-to-run rules.

**Do not change** (semantic product / protocol identifiers, not directory paths):

- npm / workspace package name `@mimo-ai/cli`, `@mimo-ai/plugin`, `@mimo-ai/shared`, `@mimo-ai/sdk`
- root package `"name": "opencode"`
- provider ids, external-import sources, MCP origin strings, observability
  `serviceName`, CLI `$0`, brew/scoop/choco formula names, GitHub URLs
  (`sst/opencode`, `anomalyco/opencode`, …)
- `packages/shared` bin key `opencode`
- migration journal *contents* under `packages/cli/migration/` (only the
  directory moves; do not edit shipped `migration.sql`)

**Lockfile.** Bun records workspace package paths in `bun.lock`
(`"packages/opencode"` and `"@mimo-ai/cli": ["@mimo-ai/cli@workspace:packages/opencode"]`).
After `git mv`, update those path tokens, then run `bun ci` to confirm the
lockfile still installs frozen.

**No compatibility shim.** Old paths break on purpose. CI and scripts must be
updated in the same change; we do not leave `packages/opencode` symlinks or
dual-path fallbacks.

**Verification boundary.** From the worktree: `bun typecheck` at root (covers
all workspaces + `tsconfig.scripts.json`), focused tests in `packages/cli` for
touched path-string surfaces, and residual `packages/opencode` path refs gone
outside intentional non-directory identifiers. Full suite is not required for
this rename.

## [S3] Out of Scope

- Renaming npm packages or the root package name
- Renaming binaries (`mimo` / `opencode` bin entries)
- Reworking historical narrative in specs beyond path-token replacement
- Provider / external-import / MCP origin identifier changes
- Touching shipped `migration/*/migration.sql` content
- Web/Desktop surfaces (already unmaintained)

## Tasks

- [x] T1: `git mv packages/opencode packages/cli` and fix `bun.lock` workspace paths — acceptance: directory is `packages/cli`; `bun ci` installs with frozen lockfile; `@mimo-ai/cli` still resolves as workspace (covers: S2)
- [x] T2: Update root scripts/config/CI/build helper paths — acceptance: `package.json`, `tsconfig*.json`, `local-install.sh`, `script/*`, `.github/workflows/test.yml` all reference `packages/cli` and none reference `packages/opencode` (covers: S2; depends: T1)
- [x] T3: Update in-package path comments, prompt templates, tests, snapshot, SDK comment — acceptance: `rg packages/opencode packages/` is empty except semantic product identifiers; touched path tests still pass (covers: S2; depends: T1)
- [x] T4: Update living docs and historical compose specs — acceptance: `rg packages/opencode` across repo is empty outside intentional non-directory identifiers; AGENTS/CONTRIBUTING examples use `packages/cli`; AGENTS.md drops Core Focus / how-to-run test-typecheck notes (covers: S2; depends: T1)
- [x] T5: Verify typecheck + focused tests + residual reference check — acceptance: root `bun typecheck` PASS; focused tests in `packages/cli` PASS; residual `packages/opencode` path refs gone (covers: S2; depends: T2, T3, T4)
