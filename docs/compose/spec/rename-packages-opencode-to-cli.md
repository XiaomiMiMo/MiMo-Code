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

## Tasks

- [x] T1: `git mv packages/opencode packages/cli` and fix `bun.lock` workspace paths — acceptance: directory is `packages/cli`; `bun ci` installs with frozen lockfile; `@mimo-ai/cli` still resolves as workspace (covers: S2)
- [x] T2: Update root scripts/config/CI/build helper paths — acceptance: `package.json`, `tsconfig*.json`, `local-install.sh`, `script/*`, `.github/workflows/test.yml`, `patches/install-korean-ime-fix.sh` all reference `packages/cli` and none reference `packages/opencode` (covers: S2; depends: T1)
- [x] T3: Update in-package path comments, prompt templates, tests, snapshot, SDK comment — acceptance: `rg packages/opencode packages/` is empty except semantic product identifiers; touched path tests still pass (covers: S2; depends: T1)
- [x] T4: Update living docs and historical compose specs — acceptance: `rg packages/opencode` across repo is empty outside intentional non-directory identifiers; AGENTS/CONTRIBUTING examples use `packages/cli`; AGENTS.md drops Core Focus / how-to-run test-typecheck notes (covers: S2; depends: T1)
- [x] T5: Verify typecheck + focused tests + residual reference check — acceptance: root `bun typecheck` PASS; focused tests in `packages/cli` PASS; residual `packages/opencode` path refs gone (covers: S2; depends: T2, T3, T4)
