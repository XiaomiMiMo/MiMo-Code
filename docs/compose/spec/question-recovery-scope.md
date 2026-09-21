---
feature: question-recovery-scope
status: in-progress
updated: 2026-09-21
branch: codex/question-recovery-scope
commits:
---

# Question Recovery Scope

## Report

## [S1] Problem

Entering a project synchronously scans historical tool JSON to find abandoned questions. This work grows with the directory's entire transcript history even when no question needs repair. Embedded Node consumers execute the scan on their calling thread, making their UI unresponsive.

## [S2] Design

Project bootstrap retains the existing indexed actor-registry abandonment update, including the other-process, age and status guards. It never reads or rewrites message or part history to reclaim questions, nor schedules that scan for later. Registry initialization and actor wait semantics remain unchanged.

Question requests are held in instance-local memory; persisted tool rows do not recreate a request after restart. Opening a project therefore leaves historical question parts unchanged and never re-prompts expired questions. Existing read-only recovery queries still offer the interrupted turn for the selected session.

Explicit user work uses the existing session-scoped lifecycle: a fresh prompt on an idle session repairs pending/running main-slice tool parts, including questions. That tool cleanup leaves question/tool parts in busy/retrying sessions and independently executing subagent slices unchanged. This is a tool-part guarantee, not a guarantee that all assistant-message metadata is untouched by the separate existing assistant cleanup. The existing ownership-scoped main-run finalizer continues to repair interrupted tools. Read-only recovery discovery does not mutate historical questions. Resuming a turn continues through the existing recovery/runner implementation; this change does not add a new recovery path or promise to settle every old subagent transcript row merely by browsing it.

The obsolete directory-wide question reclamation implementation and tests for its removed mutation contract are removed. Regression coverage exercises real project bootstrap with persisted historical rows, verifies actor abandonment still works, and exercises existing selected-session prompt/recovery behavior with cold history in another session. A database access guard makes any startup attempt to inspect part history fail deterministically, without timing thresholds or a large real database.

## [S3] Out of Scope

Physical database archiving, new indexes/migrations, background transcript scans, desktop application changes, new question replay UI, and redesigning actor abandonment, assistant-message cleanup or cross-process ownership are outside this fix. Large individual-session hydration costs remain a separate concern.

## Tasks

- [ ] T1: Prove bootstrap does not inspect or mutate question history while actor abandonment remains functional — acceptance: real bootstrap regression fails before the fix and passes afterward, including the history-read guard (covers: S2).
- [ ] T2: Remove directory-wide question reclamation and retain actor-only abandonment — acceptance: startup contains no transcript scan or deferred replacement, and registry guard tests pass (covers: S2; depends: T1).
- [ ] T3: Verify selected-session recovery and tool cleanup — acceptance: pending/running questions in an idle selected main slice are repaired on fresh prompt; unrelated-session question parts, active-subagent question parts and busy/retry question parts remain unchanged; recovery discovery remains read-only; package typecheck and Node build pass (covers: S2; depends: T2).
