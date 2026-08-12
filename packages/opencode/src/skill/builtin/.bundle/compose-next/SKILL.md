---
name: compose-next
description: Use for multi-step feature work, bug fixes, or refactors where requirements need to settle, a feature document should carry design + tasks + delivery evidence, and the change deserves independent review before merge. Use it only when the user explicitly requests this workflow, whether with `/compose-next`, by name, or in any other clear natural language; do not infer the request from task complexity alone. Not for one-shot edits, single-file tweaks, or answering questions — those need no orchestration overhead.
---

# Compose Next

Compact end-to-end contract for grill → spec → workspace → implement → verify → review → finalize → finish. One skill load, no internal skill hand-offs.

When writing a checkpoint or compacting context, preserve this recovery instruction in the checkpoint or compacted summary: on resumption, if the Compose Next instructions are absent, reload the `compose-next` skill before continuing.

Enter this workflow only on an explicit user request. Any clear natural-language instruction to use this workflow counts just like `/compose-next`; the user does not need to know or name the skill. If the user has not clearly requested the workflow, do the work directly and run none of the phases below; do not infer consent merely because the task is large or resembles a Compose task.

## Step 0 — Orient

Inspect the repository, its instructions (`AGENTS.md`, `README`, existing spec files), and recent changes before asking anything. Do not ask the user for facts the environment already answers.

Decide the shape of the work:

- **Fully constrained mechanical change with no durable design surface** → skip Grill and Spec, go to Workspace then Implement.
- **Requirements or design ambiguous** → Grill first.
- **Requirements clear, feature deserves a durable document** → Spec first.

User gates and project overrides:

- If the user explicitly requests `without worktree` or specifies a worktree or workspace path, use that workspace choice and skip the default worktree gate. Do not ask again for worktree consent.
- If the user explicitly says `without spec`, "no spec needed", "this is a small fix", or gives an equivalent instruction, skip the durable feature document and its spec gate. Keep verification and review when the task still warrants them.
- An explicit project instruction, `AGENTS.md`, or user-provided agent/worktree configuration may define a project-specific worktree path, branch convention, spec path, or spec format. Use that configuration instead of the defaults in this skill. Record the override in the feature document or final report when it changes the normal artifact location.

Every path passes through Workspace before Implement; no branch skips it.

## Grill — resolve decisions

Resolve one decision axis at a time. A single decision may bundle multiple dependent fields in one structured question; unrelated decisions require separate turns.

Use the `question` tool for every user decision:

- Put known choices in `options`. Each option gets a concise `label` and a `description` explaining the consequence. List the recommendation first and mark its label `(Recommended)`.
- For consequential choices, include 2–3 viable alternatives.
- When choices cannot be enumerated, still call `question` with `options: []` for free-text.
- Do not ask for permission to continue when no decision remains.

Split requests spanning independent subsystems before refining each part. Do not begin implementation until requirements and scope are settled.

### Never-Ask handling

If the `question` tool is unavailable or returns `[Never-Ask]`, resolve **this one decision** yourself and continue:

1. Choose the option marked `(Recommended)` when repository evidence still supports it and it can run unattended.
2. Otherwise choose the closest minimal-scope option supported by the evidence; prefer text-only, non-interactive work.
3. If the decision includes destructive or irreversible work, choose a non-destructive path that preserves progress; never auto-approve the destructive option.
4. State the option selected and the reason in the response.

Never-Ask applies to the current decision only. At every later decision point, call the `question` tool again — Never-Ask does not disable future questions or pause the workflow.

## Spec — one document per feature

Maintain one document per feature at `docs/compose/spec/<feature-name>.md` from the repository root. Do not add a date to the filename. A user-specified location overrides this path. Edit an existing document in place; never create a separate plan or report.

### Template

```markdown
---
feature: <feature-name>
status: designed | in-progress | delivered
updated: YYYY-MM-DD
branch: <branch-name>
commits: <base-sha>..<head-sha> # filled at delivery
---

# <Feature Name>

## Report

## [S1] Problem
Describe the user-visible problem.

## [S2] Design
Record the chosen behavior and the contracts needed to implement it.

## [S3] Out of Scope
State explicit boundaries.

## Tasks
- [ ] T1: <work item> — acceptance: <observable result> (covers: S2)
- [ ] T2: <work item> — acceptance: <observable result> (covers: S2; depends: T1)
```

### Design-time rules

- Leave `Report` empty and set `status: designed`.
- Keep `[Sn]` anchors stable when headings change; never renumber existing anchors.
- Record settled decisions and precise contracts, not exploration history or file-level code dumps. Include architecture, interfaces, data flow, error behavior, and testing boundaries when they affect the change.
- Make each task the smallest independently verifiable work item; give it an observable acceptance criterion. Add `depends:` only for real prerequisites; dependencies must be acyclic.
- Add `covers:` for every task implementing a design section. Every design requirement must be covered by at least one task; every reference must resolve.
- Remove placeholders such as `TBD`, "handle edge cases", and references to unspecified similar work.
- Scale detail to the change; do not pad small designs.

Before implementation, fix ambiguous requirements, contradictions, unresolved references, and unverifiable acceptance criteria. If the user is available, request document approval with the `question` tool; otherwise continue.

### Amendments

Update only affected sections, bump `updated:`, preserve anchors, and keep only the tasks required by the amendment and their dependents. Do not regenerate the document or create duplicate tasks.

## Workspace — worktree ownership

Never begin implementation on `main` or `master` without explicit user consent.

1. Compare `git rev-parse --git-dir` with `git rev-parse --git-common-dir`. If they differ, use the current linked worktree; do not nest another. A non-empty `git rev-parse --show-superproject-working-tree` indicates a submodule, not a linked worktree.
2. Create a linked worktree at `.worktrees/<slug>` by default. Run `git check-ignore -q "$path"`; if it is not ignored, write `*` to `.worktrees/.gitignore`. Then run `git worktree add "$path" -b "$branch"`.
3. Once the worktree path is resolved, use MiMoCode's `change_directory` tool to switch into it and continue the workflow there.
4. Install dependencies per repository instructions. Prefer lockfile-frozen, hardlink-friendly modes (`bun ci`, `uv sync --frozen`) over commands that mutate the lockfile. Confirm the toolchain is usable before continuing.

## Implement

Use the feature document as the source of requirements, or the conversation for an undocumented mechanical change. When a feature document exists, set its `status: in-progress` on the first implementation commit. Execute tasks in dependency order. Track multi-step work with the `task` tool.

For behavior changes with a cheap reproduction, write a failing test, confirm it fails for the intended reason, implement the smallest fix, and confirm it passes. A bug fix requires a regression test when one can be written. Skip test-first for generated code, configuration-only changes, throwaway prototypes, or explicit user direction.

Test public behavior. Do not duplicate production logic in expected values, add test-only production APIs, or assert only that mocks were called. Prefer real implementations over mocks.

For failures, reproduce before editing and identify the root cause from errors, diffs, recent commits, or boundary instrumentation. After two failed fixes, stop patching and re-derive the cause.

### Parallel work

Dispatch independent tasks in parallel when isolation prevents collisions; keep tightly coupled work together. Prefer giving parallel subagents disjoint file sets and keeping commits with the orchestrator. Give each subagent the worktree path, task, acceptance criteria, relevant spec sections, and required verification. Do not pass session history. Treat its report as a claim and inspect the resulting diff.

Continue through tasks without routine approval pauses. Stop only for an unresolved product decision, a blocker that cannot be worked around, a destructive action requiring consent, or completion.

## Verify

Before any completion claim, run the repository's relevant tests, typecheck, build, or reproduction from the correct directory and read the output. Record each command and result. Mark known baseline failures as `PRE-EXISTING` with a short identifier. Do not substitute prior output or a subagent report for fresh evidence.

Verification and review are strictly sequential. Wait for all verification commands to exit before dispatching the reviewer. Never overlap review with a resource-heavy test or application process in the same environment.

## Review

After implementation is verified and before finalizing the feature document, dispatch one fresh subagent to review the complete change.

Provide the reviewer:

- the applicable spec sections and acceptance criteria;
- the worktree path, base branch, base SHA, head SHA, and exact diff command or precomputed diff;
- a compact verification summary: one line per command with `PASS`, `FAIL`, or `PRE-EXISTING`, plus test counts when available. Do not paste full command output unless a specific failure requires it.

Do not provide an implementer-authored narrative. The reviewer may inspect the diff and run additional commands needed to validate its conclusions. It must not repeat a command already reported as passing, especially a heavy E2E suite, unless the result is stale, the code changed afterward, or concrete evidence makes the result suspect. Before any justified rerun, confirm no equivalent command is still running. Missing evidence should be reported or gathered with the cheapest non-duplicative command.

Use a reviewer model at least as capable as the strongest implementer it reviews.

Require separate conclusions for:

1. **Spec compliance** — every acceptance criterion is met and points to evidence in the diff or reviewer-observed command output.
2. **Correctness** — logic, boundaries, error handling, regressions, and tests are sound, including issues outside the written spec.
3. **Codebase consistency** — naming, structure, and local conventions match surrounding code.

Classify unmet or unverifiable acceptance criteria and correctness bugs as critical. Fix critical findings, re-verify, and re-review affected areas. Reject incorrect findings with technical evidence. If the fix-and-re-review loop stops converging — repeated findings on the same area, or fixes that introduce new criticals — stop looping and report the impasse with the remaining findings instead of forcing a pass.

For human review feedback, verify each item against the codebase, clarify ambiguous items before editing, and implement validated items one at a time with verification. Check actual usage before expanding an unused path, and surface conflicts with prior user decisions instead of silently complying.

For parallel task work, review integrated task diffs at useful boundaries only when delaying review would compound risk.

## Finalize — commit the feature document

After review passes, before finishing the branch, finalize the feature document:

1. Set `status: delivered`, bump `updated:`, and record the reviewed range as `<base-sha>..<head-sha>`.
2. Check off completed tasks; leave incomplete tasks unchecked and do not claim delivery if they block acceptance.
3. Replace `Report` with:

```markdown
## Report

**What was built** — 1-3 concise paragraphs describing the final behavior.

**Verification** — commands run and their observed results.

**Journey log** — at most 5 entries that help future work: dead ends, pivots, or transferable lessons. Preserve useful prior entries and append new ones.
```

Update a design section only when it contradicts the delivered behavior. Commit the finalized document on the feature branch before finishing. This documentation-only commit sits outside the recorded reviewed range by construction; it does not restart verification or review, and CI re-running on it is expected.

## Finish

Do not auto-finish. After Finalize, report branch, base, head SHA, worktree, feature-doc path, and suggest a closing action.

If the user asks to finish but the path is unclear, use the `question` tool to settle:

- closing action: local merge / open PR / push only / keep the branch;
- which base branch to merge or target;
- keep or remove the worktree.

Worktree pitfalls:

- Local merge and `gh pr merge` run from the main repository checkout — the base branch cannot be checked out while another worktree holds it.
- `git worktree remove` only on `.worktrees/` or the path scoped by the prompt / `AGENTS.md`.
