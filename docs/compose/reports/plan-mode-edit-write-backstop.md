---
feature: plan-mode-edit-write-backstop
status: delivered (PR #1330)
specs: []
plans: []
branch: fix/plan-mode-edit-write-backstop
commits: 9c8f950..HEAD
related: docs/compose/reports/plan-mode-write-restrictions.md (PR #1324, kept as draft for comparison)
---

# Plan Mode edit/write Backstop — Final Report

> No plan doc was written for this branch; it was implemented directly as a
> deliberately-simplified alternative to PR #1324. This report is the
> authoritative record of the final state and the scope decisions.

## Context & Why This Exists

A first attempt (branch `fix/plan-mode-write-restrictions`, PR #1324) hardened
plan mode by routing `bash`/`change_directory`/`workflow` to `"ask"` and forcing
plan-spawned subagents to a read-only allowlist, on top of the edit/write block.
In review it was sound, but a design discussion concluded it overreached:

- **opencode/mimocode favors trusting the model and minimizing user prompts.**
  The permission layer is a **backstop**, not an active gate.
- Gating `bash` via `"ask"` causes **repeated confirmation prompts** for plainly
  read-only shell use (`git status`, `ls`, `cat`, running tests), because the
  codebase has **no read-only-bash classifier** — every non-`cd` command under an
  `"ask"` ruleset prompts. (Claude Code, by contrast, ships a built-in read-only
  command allowlist and runs those silently; mirroring that is a separate, larger
  effort.)
- The model also wasn't told *which* tools were gated — only a vague "read-only
  only" — so it would try `bash`, hit the prompt, and offload the decision to the
  user.

PR #1324 was therefore set to **draft** (kept for human experts to compare), and
this branch implements the minimal backstop.

## What Was Built

Three focused changes:

1. **Root-cause permission fix** (`src/permission/index.ts`). The `ask` loop used
   to evaluate the agent ruleset and persisted approvals together in one
   `findLast`, so an `"always"`-approved action (e.g. an edit approved in build
   mode) could out-rank an explicit ruleset `deny` and leak a write through. Now
   the ruleset is evaluated **alone first** — a `deny` short-circuits — and
   approvals are consulted only to upgrade an otherwise-`"ask"` to `"allow"`. This
   is the genuine root cause of "edited a file while in plan mode".

2. **edit/write backstop** (`src/agent/agent.ts`). New `Agent.hardPermission`
   field (rules re-appended *after* the user/session merge so they always win) and
   a `runtimePermission(agent, sessionPermission)` helper. Plan's `edit` deny +
   plan-file allow exception moves out of `permission` (where `user` config was
   merged last and could override it) into `hardPermission`. A user/session
   `permission: { edit: "allow" }` can no longer relax it. `runtimePermission` is
   wired into all five evaluation sites: `session/llm.ts` x2 (preapproval +
   `resolveTools` schema filtering), `session/prompt.ts` x2 (main tool ask + subtask
   ask), `cli/cmd/debug/agent.ts` x2 (tool-disabled view + ask callback).

3. **Explicit plan prompt** (`src/session/prompt.ts`). Replaced the vague
   "no non-readonly tools / READ-ONLY actions only" reminder with explicit
   guidance — prefer the dedicated read-only tools (`read`/`grep`/`glob`/`lsp`),
   and use `bash` only for the gap they can't cover and only when certain it is a
   pure read (`git status`/`log`/`diff`). The forbidden list is explicit and
   strict: writes to non-plan files are hard-blocked; `test`/`lint`/`typecheck`/
   `build` are forbidden by default (lint may be `--fix`, test may write
   snapshots/db, build writes artifacts) UNLESS the model has verified the exact
   invocation has no side effects; no commits, no install, no `change_directory`,
   no `workflow`. It also tells the model to take the
   read-only action itself rather than push avoidable confirmation prompts onto the
   user. This is the **model-adherence layer** that complements the permission
   backstop.

## Architecture

`runtimePermission(agent, session)` = `Permission.merge(agent.permission,
session ?? [], agent.hardPermission ?? [])`. Because `hardPermission` is appended
last, it wins over any allow a user/session/approval could introduce. The
mechanism is data-driven — no `agent.name === "plan"` checks were added (the
pre-existing plan-mode prompt gate and `tool/plan.ts` check are unrelated to the
permission mechanism).

Plan's `hardPermission`:
```
edit: { "*": "deny", ".mimocode/plans/*.md": "allow", <data>/plans/*.md: "allow" }
```
The `"*":"deny"` carries a non-`"*"` allow exception, so `Permission.disabled()`
does **not** strip the edit tool from the schema — entering plan mode does not
mutate the tool list (the prefix-cache concern from PR #1207). All write tools
(`write`/`edit`/`multiedit`/`apply_patch`/`notebook_edit`) funnel through
`ctx.ask({ permission: "edit" })`, so this single rule governs every file write.

### Scope decisions (vs PR #1324)

- **Only edit/write is enforced at the permission layer.** `bash`,
  `change_directory`, `workflow` are NOT in `deny`/`ask` — left to the model's
  discipline + the explicit prompt. This is the "backstop, not gate" stance.
- **No `subagentToolAllowlist` / `READONLY_TOOLS` / actor wiring.** Without bash
  gating there's no write vector to delegate around, so forcing subagents
  read-only is unnecessary complexity. Dropped.
- **Kept** the data-driven `hardPermission` mechanism, the single
  `runtimePermission` helper at every site, and the persisted-approval root-cause
  fix — these are correct regardless of scope.

## Usage

No configuration surface. Entering plan mode applies the edit/write backstop
automatically. In plan mode: reads/search/research subagents and read-only bash
work normally; editing the plan file is allowed; editing any other file is denied
at call time and **cannot** be relaxed by user/session config. Side-effecting
bash/commits/etc. are discouraged by the prompt but not hard-blocked by the
permission layer.

## Verification

- `bun test test/permission test/agent` — **164 pass / 0 fail**.
- `bun typecheck` — clean.
- New tests:
  - Persisted `"always"` approval cannot override a ruleset `deny` (`next.test.ts`).
  - Plan denies edits except plan files via `runtimePermission` (`agent.test.ts`).
  - Plan edit deny is a backstop: user config `edit:"allow"` + session allow both
    lose to `hardPermission` (`agent.test.ts`).
  - Plan keeps the edit tool in the schema — not stripped (`agent.test.ts`).
  - Plan does NOT restrict bash/change_directory/workflow (`agent.test.ts`).
  - Build agent unaffected — no `hardPermission` (`agent.test.ts`).
- Name-check audit: the permission mechanism adds no `=== "plan"` checks.
- `git diff --check` — clean.

## Files Changed

| File | Change |
|------|--------|
| `src/permission/index.ts` | ask loop: evaluate ruleset alone before approvals |
| `src/agent/agent.ts` | `hardPermission` field + `runtimePermission`; plan edit-only backstop |
| `src/session/llm.ts` | 2 sites -> `runtimePermission` (type->value import) |
| `src/session/prompt.ts` | 2 sites -> `runtimePermission`; explicit plan reminder |
| `src/cli/cmd/debug/agent.ts` | 2 sites -> `runtimePermission` |
| `test/permission/next.test.ts` | persisted-approval-vs-deny test |
| `test/agent/agent.test.ts` | backstop + scope tests |

## Open / Follow-up

- **Read-only bash classifier** (mirror Claude Code's built-in read-only command
  allowlist, run silently in plan mode): the richer way to let plan run
  `git status`/`ls`/tests without prompting. Out of scope here; worth a separate
  issue if plan-mode shell use becomes friction.
- **MCP write tools** are outside all of this — MCP calls don't route through the
  `edit` permission key. Pre-existing, orthogonal, theoretical write vector in
  plan mode. Track separately.
- This branch is **PR #1330** (ready for review); PR #1324 (the "active gate"
  approach) is kept as a **draft** for human experts to compare the "minimal
  backstop" vs "active gate" approaches.
