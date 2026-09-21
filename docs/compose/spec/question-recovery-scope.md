---
feature: question-recovery-scope
status: delivered
updated: 2026-09-21
branch: codex/question-recovery-scope
commits: 4101b3d4..0271ca02
---

# Question Recovery Scope

## Report

**What was built** — Project bootstrap now settles abandoned actor metadata without reading message or part history. The synchronous directory-wide question JSON scan and its obsolete mutation tests are removed. Nothing schedules the same scan later, and no schema migration or physical archive is required.

Persisted questions remain historical until existing selected-session execution cleanup handles them. Fresh prompts repair idle main-slice question parts; pending requests are not reconstructed from storage. The regression suite verifies unchanged unrelated-session and active-subagent question parts, busy/retry protection, read-only recovery discovery, and startup actor settlement. Merely browsing an old transcript does not promise to repair every historical status.

**Verification** — Commands below ran from `packages/opencode` unless noted.

- `bun test test/actor/abandon-question-bootstrap.test.ts --timeout 30000` before the fix: expected failure, exposing the actual historical part SELECT queries.
- `bun test test/actor/registry.test.ts test/actor/abandon-question-bootstrap.test.ts test/session/prompt-orphan-tool-parts.test.ts test/server/session-recovery.test.ts --timeout 30000`: PASS, 64 tests, 190 assertions.
- `bun test test/actor/abandon-question-bootstrap.test.ts --timeout 30000` after the final fixture refinement: PASS, 1 test, 9 assertions. The refinement uses public session writes and simulates stale actor activity after those writes; production and other test files were unchanged.
- `bun typecheck` on the final code/test state: PASS.
- `MODELS_DEV_API_JSON=./test/tool/fixtures/models-api.json bun run script/build-node.ts`: PASS. No production changes followed this build.
- `git diff --check` at repository root: PASS.
- Independent review of the recorded range: PASS for spec compliance, correctness and codebase consistency; no remaining findings. The documentation-only scope clarification did not change production or tests.

**Journey log**

1. Moving synchronous SQLite work to a detached Effect or timer would still block the caller's event loop; removing the redundant history scan eliminates that cost.
2. Question waiters live in instance-local memory. Persisted running parts do not restore an answerable request after restart, so startup reclamation is unnecessary for input unblocking.
3. Keep the small actor abandonment update: actor waiters depend on its persisted terminal status.
4. Public part writes refresh actor activity. Crash fixtures must backdate the actor after seeding messages and parts.
5. Review narrowed the isolation guarantee to question/tool parts; the separate preexisting assistant-message cleanup is outside this change.

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

- [x] T1: Prove bootstrap does not inspect or mutate question history while actor abandonment remains functional — acceptance: real bootstrap regression fails before the fix and passes afterward, including the history-read guard (covers: S2).
- [x] T2: Remove directory-wide question reclamation and retain actor-only abandonment — acceptance: startup contains no transcript scan or deferred replacement, and registry guard tests pass (covers: S2; depends: T1).
- [x] T3: Verify selected-session recovery and tool cleanup — acceptance: pending/running questions in an idle selected main slice are repaired on fresh prompt; unrelated-session question parts, active-subagent question parts and busy/retry question parts remain unchanged; recovery discovery remains read-only; package typecheck and Node build pass (covers: S2; depends: T2).
