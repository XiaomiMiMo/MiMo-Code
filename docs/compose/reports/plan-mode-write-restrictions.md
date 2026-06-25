---
feature: plan-mode-write-restrictions
status: delivered
specs: []
plans:
  - docs/compose/plans/2026-06-25-plan-mode-write-restrictions.md
branch: fix/plan-mode-write-restrictions
commits: 83d9b19..17b5c0b
---

# Plan Mode Write Restrictions — Final Report

## What Was Built

Plan mode now enforces its read-only intent at the permission layer without ever
removing a tool from the model's schema. Writes are blocked at call time (edit to
non-plan files is denied; `bash`, `change_directory`, and `workflow` require
confirmation), while every tool stays present in the tool list so switching into
plan mode mid-session does not mutate the schema and invalidate the model's
prefix cache. Plan can still spawn research subagents (e.g. `explore`), but those
subagents are forced read-only so writes cannot be delegated around the
restriction.

The restriction is expressed declaratively as data on the plan agent definition
(`hardPermission` + `subagentToolAllowlist`), not as scattered
`agent.name === "plan"` runtime checks. A single `runtimePermission` helper applies
these invariants at every permission-evaluation site. Separately, a real
root-cause bug was fixed: a persisted "always" approval (e.g. an edit approved in
build mode) could out-rank plan's `edit:deny` and leak a write through — approvals
can now only upgrade an `ask`, never override a `deny`.

## Architecture

Three layers cooperate:

1. **`Agent.Info` data fields** (`src/agent/agent.ts`):
   - `hardPermission?: Permission.Ruleset` — rules re-appended *after* the
     user/session merge so they always win.
   - `subagentToolAllowlist?: string[]` — tool allowlist forced on any subagent
     this agent spawns.
   - `READONLY_TOOLS` — exported constant, the read-only toolset plan forces on
     its subagents.

2. **`runtimePermission(agent, sessionPermission)`** (`src/agent/agent.ts`):
   `Permission.merge(agent.permission, sessionPermission ?? [], agent.hardPermission ?? [])`.
   Every evaluation site routes through it — `session/llm.ts` (×2: preapproval +
   `resolveTools` schema filtering), `session/prompt.ts` (×2: main tool ask +
   subtask ask), `cli/cmd/debug/agent.ts`. No agent-name special-casing anywhere.

3. **Permission evaluation** (`src/permission/index.ts`): the `ask` loop evaluates
   the ruleset alone first — an explicit `deny` short-circuits before persisted
   approvals are consulted; approvals can only turn an `ask` into `allow`.

Plan's `hardPermission`:
```
plan_exit: "allow"
bash: "ask"
change_directory: "ask"
workflow: "ask"
external_directory: { <data>/plans/*: "allow" }
edit: { "*": "deny", ".mimocode/plans/*.md": "allow", <data>/plans/*.md: "allow" }
```
`task` is intentionally left at the inherited `allow`. Subagent containment is
handled in `src/tool/actor.ts`: before spawning, it reads
`subagentToolAllowlist` off the spawning agent and forces it onto the child.

### Design Decisions

- **Never use a bare `{"*":"deny"}` for a plan-restricted tool.** `Permission.disabled()`
  strips a tool from the model schema *only* when the last-matching rule is exactly
  `pattern==="*" && action==="deny"`. A bare deny on `bash`/`task`/etc. would remove
  those tools from the list when entering plan mode — the exact prefix-cache
  instability PR #1207 fixed for `plan_enter`/`plan_exit`. So restricted tools use
  `"ask"` (stays visible, prompts at call time, headless agents get `DeniedError`
  via the existing `interactive:false` path) or a `deny` carrying a non-`"*"` allow
  exception (`edit`, which keeps the plan-file allow).
- **`task` stays allowed; subagents are constrained instead.** Plan mode's main use
  is research, which needs `explore`/`general` subagents. Denying `task` would block
  that. Forcing spawned subagents to `READONLY_TOOLS` keeps research working while
  preventing delegated writes.
- **`READONLY_TOOLS` is deliberately separate from the `explore` agent's inline tool
  list.** They overlap but mean different things — `explore` permits read-only
  `bash` for shell exploration, which a plan subagent must not have. Merging them
  would be a wrong abstraction.
- **Data-driven invariants over name checks.** Any future restricted agent declares
  its own `hardPermission`/`subagentToolAllowlist`; `runtimePermission` and the actor
  wiring stay generic.

## Usage

No configuration surface. Entering plan mode (`plan_enter`) applies the restrictions
automatically; `plan_exit` returns to build. In plan mode:
- Reads, search, research subagents: work normally.
- Editing a plan file (`.mimocode/plans/*.md`, `<data>/plans/*.md`): allowed.
- Editing any other file: denied at call time.
- `bash` / `change_directory` / `workflow`: prompt for confirmation interactively;
  auto-denied for non-interactive (headless) agents.
- Spawned subagents: limited to `READONLY_TOOLS`.

User/session config cannot relax these — `hardPermission` is applied last.

## Verification

139 tests pass across `test/agent/agent.test.ts`, `test/permission/next.test.ts`,
`test/tool/actor.test.ts`; `bun typecheck` clean. Key coverage:

- Persisted approval cannot override ruleset deny (`next.test.ts`).
- Plan denies edits except plan files; `bash`/`change_directory`/`workflow` resolve
  to `ask`; `task` stays `allow`; `hardPermission` wins over config/session allow;
  build agent unaffected (`agent.test.ts`).
- **Prefix-cache stability guard**: enumerates the real registered tool universe and
  asserts every primary agent strips the same set as build via
  `Permission.disabled(runtimePermission(agent))`. Manually verified to FAIL when
  plan's `bash:"ask"` is regressed to `bash:"deny"` — so it catches any future bare
  deny that would mutate the tool list.
- Plan-spawned subagent receives exactly `READONLY_TOOLS` (`actor.test.ts`).

## Journey Log

> Brief notes on what informed the final design. Not required reading.

- [pivot] First implementation (mirroring third-party PR #1301) used bare
  `bash/task/workflow/change_directory: "deny"`. Caught in review: that strips tools
  from the schema → tool-list mutation on mode switch → prefix-cache invalidation,
  and `task:"deny"` blocks plan from spawning research subagents. Reworked to
  `ask` + read-only subagent allowlist.
- [lesson] A tool only disappears from the model schema under `{"*":"deny"}`; `"ask"`
  or a deny-with-exception keeps it visible. This is the lever for "restricted but
  present". (See PR #1207, which made plan_enter/plan_exit always-visible for the
  same reason.)
- [lesson] The user-reported "edited in plan mode via edit" was NOT a missing rule —
  it was persisted approvals being flattened into the ruleset and out-ranking deny
  via `findLast`. The genuine root cause was in the approval evaluation order.
- [lesson] Prefer a data-driven invariant test (enumerate all primary agents, assert
  identical stripped set) over a hardcoded per-tool assertion — it generalizes to any
  future agent and any future tool without maintenance.

## Source Materials

| File | Role | Notes |
|------|------|-------|
| `docs/compose/plans/2026-06-25-plan-mode-write-restrictions.md` | Implementation plan (v2) | Complete; v1 approach recorded in its "Why better than #1301" section |
