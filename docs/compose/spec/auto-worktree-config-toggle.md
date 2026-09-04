---
feature: auto-worktree-config-toggle
status: delivered
updated: 2026-08-29
branch: feat/auto-worktree-config-toggle
base: be5af909ae
---

# Auto-Worktree Config Toggle

## Report

**What was built** — Added a top-level optional boolean `auto_worktree` to `Config.Info`. The default is off: omitting the key or setting `false` means the Auto-Worktree Notice is never injected. Setting `true` preserves the previous soft-hint behavior (once per primary root session after a main-worktree mutation). Conflict detection and `POST /experimental/worktree/auto` remain outside this flag. Bundled `mimocode-docs` config table and the generated JS SDK types list the new key.

**Verification** — `bun typecheck` (packages/opencode) PASS; `bun test test/session/auto-worktree-notice.test.ts` PASS 10/10; `bun test test/tool/auto-worktree-scan.test.ts test/tool/auto-worktree-bash-write.test.ts` PASS 47/47; `bun test test/config` PASS 177 + new `test/config/auto-worktree.test.ts` 3/3; `./packages/sdk/js/script/build.ts` regenerated `packages/sdk/js/src/v2/gen/types.gen.ts` including `auto_worktree?: boolean`.

**Journey log**

- Product default flipped from always-on to off; existing notice suite now writes `auto_worktree: true` in `providerConfig` so it keeps testing the on path.
- Reviewer flagged missing SDK regen: `./packages/sdk/js/script/build.ts` is required after any `Config.Info` schema change; the artifact that updates is `packages/sdk/js/src/v2/gen/types.gen.ts` (openapi.json is not the generated surface for this key).
- Unit `Config.Info.parse` tests (`test/config/checkpoint-fork.test.ts` pattern) are the local convention for new toggles; integration coverage alone is not enough for review consistency.

## [S1] Problem

The Auto-Worktree Notice is injected unconditionally: every primary root session that mutates a git main worktree gets a once-per-session soft hint (`packages/opencode/src/session/prompt.ts` `insertReminders`). There is no config key, so users who always work on the main worktree — or who already open worktrees themselves — cannot turn the notice off. `mimocode.json` has no corresponding field.

## [S2] Design

Add one top-level optional boolean in `InfoSchema` (`packages/opencode/src/config/config.ts`):

```jsonc
{
  "auto_worktree": false   // omit or false = off (default); true = inject the notice
}
```

Contract:

- **Default `false` / omitted** — do not inject the Auto-Worktree Notice. This is a deliberate product default: the feature ships off.
- **`true`** — keep the current soft-hint behavior: once per session, after a completed write or successful git mutation lands in a git MAIN worktree, inject the existing `buildAutoWorktreeNotice` system-reminder on the last user message and set `session.auto_worktree_hint_sent`.
- Scope is the notice only. `checkConflict` / `POST /experimental/worktree/auto` are unchanged and remain outside this flag.
- The existing once-per-session gate (`auto_worktree_hint_sent`, `primary` agent, `!parentID`) stays; the flag is an outer gate that skips the entire block when off.
- When the flag is off, `auto_worktree_hint_sent` is not written and `firstMutatedMainWorktree` is not consulted, so no side effects.

Access path in `insertReminders`: `(yield* config.get()).auto_worktree === true` in the outer condition. Do not change the system prompt.

## [S3] Out of Scope

- Nested `auto_worktree: { notice, create }` shapes, CLI flags, or TUI settings UI.
- Changing conflict-detection behavior or wiring `POST /worktree/auto` into any host client.
- Migrating or flipping `auto_worktree_hint_sent` for sessions that already received the notice under the old always-on behavior.
- Changing notice copy, habit detection, or write-tool detection lists.

## Tasks

- [x] T1: Add `auto_worktree` to config schema — acceptance: `InfoSchema` accepts optional boolean with a description stating default false and notice-only scope; project/global JSON parse with and without the key (covers: S2)
- [x] T2: Gate the notice injection — acceptance: `insertReminders` skips the entire auto-worktree block when the flag is not `true`; when `true`, existing once-per-session injection still fires (covers: S2; depends: T1)
- [x] T3: Regression tests — acceptance: tests cover default-off (no notice, no `auto_worktree_hint_sent` write), explicit-on (notice fires as before), and explicit-off; package typecheck for the touched files passes (covers: S2; depends: T2)
