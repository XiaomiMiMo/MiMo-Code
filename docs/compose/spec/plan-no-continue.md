---
feature: plan-no-continue
status: delivered
updated: 2026-07-23
branch: plan-no-continue
commits: 29a107adfe76cfb67f73862115f56eebb007f569..5006141ccd8dc0088a8a791295db2160891fc971
---

# Plan mode: non-Yes paths must guide the model to continue planning

## Report

**What was built** — `plan_exit`/`plan_enter` answered "No" no longer throw `QuestionRejectedError` (which hard-stopped the turn and left an intent-free "dismissed" error); both now resolve normally with `switched: false` and explicit stay-in-mode guidance — `plan_exit`'s output instructs the model to use the question tool to ask what to refine and forbids implementing. Custom-feedback answers additionally carry a "mode did NOT change, do not implement" reminder. Esc (dismiss) still rejects and stops the turn.

Every plan→plan turn now injects a one-line synthetic system-reminder (plan mode active, only the plan file is writable, end the turn with question or plan_exit) — deliberately short per user direction to save tokens; the full workflow reminder remains entry-transition-only. A dedup guard keeps it to exactly one reminder per user message across multi-step turns (see S2), and upgrade impact on resumed sessions is a one-time incremental prefix-cache miss only (see S2).

**Verification** — from `packages/opencode`: `bun typecheck` PASS; `bun test test/tool/plan.test.ts` PASS (4 new tests: No/feedback/Esc on plan_exit, No on plan_enter); `bun test test/session/plan-reminder-dedup.test.ts` PASS (multi-step entry + continuation turns each carry exactly one reminder); `bun test test/tool/question.test.ts test/agent/agent.test.ts test/permission/disabled.test.ts test/session/prompt.test.ts` PASS (71); `bun test test/tool/tool-script.test.ts` PASS (47). Independent reviewer: spec compliance MET, no correctness bugs, style consistent.

**Journey log**
- Tool pipeline appends `truncated: false` to metadata — assert with `toMatchObject`, not `toEqual`.
- `Question.Service.reject` takes a bare `requestID`, unlike `reply` which takes an object; passing an object silently no-ops (logged warning) and hangs the awaiting fiber until test timeout.
- Esc semantics survive the fix for free: the `RejectedError` for dismissal originates inside `question.ask`'s deferred, not from the removed `answer === "No"` re-throw.
- The continuation reminder was first written as 3 lines; user flagged token cost on chatty planning sessions — compressed to one line.
- `insertReminders` runs per-step, not per-turn, and persists parts — any unconditional injection there duplicates on multi-step turns. The base entry branch only avoided this by accident (its condition flips after step 1). New injections need an explicit content-marker dedup guard.

## [S1] Problem

When the model calls `plan_exit` (or `plan_enter`) and the user does not pick "Yes", the model either goes silent or misbehaves (issue #1812):

- **"No"** — `plan.ts` throws `Question.RejectedError`, whose message is the intent-free "The user dismissed this question". `processor.ts:377` then sets `ctx.blocked`, hard-stopping the turn. The model never responds to the user's explicit "stay in plan mode and refine" decision, and next turn only sees a failed tool call with no guidance.
- **Custom feedback** — the tool returns `User chose not to switch yet and provided feedback: ...` with no instruction that plan mode is still active. Models routinely misread the feedback as approval and start implementing while in plan mode (reading files, attempting edits via bash — only the `edit` tool is hard-blocked).
- **Subsequent plan turns** — the full plan-mode system-reminder is injected only on the transition *into* plan mode (`prompt.ts:810` returns early when the previous assistant message was already plan). Long planning conversations lose the constraint entirely.

## [S2] Design

### plan.ts — replace RejectedError on "No" with a guiding tool result

Applies to both `PlanExitTool` and `PlanEnterTool` (symmetric fix, user-confirmed).

- `plan_exit`, answer `"No"`: do NOT throw. Return a normal result:
  - `title`: "Staying in plan mode"
  - `output`: states that the user chose to stay in plan mode and continue refining; instructs the model it must NOT implement, and to use the `question` tool to ask the user which aspects of the plan to refine or change.
  - `metadata`: `{ switched: false, feedback: "" }`
- `plan_enter`, answer `"No"`: same shape; output states the user chose to stay in the current mode and the model should continue the current task without switching.
- Custom-feedback branch (answer is neither "Yes" nor "No"), both tools: keep returning the feedback, and append an explicit reminder that the mode did not change — for `plan_exit`: plan mode is still active, do not implement; address the feedback by refining the plan file, then call `plan_exit` again when ready.
- **Esc (dismiss)**: unchanged. The `RejectedError` for Esc originates inside `question.ask` itself (deferred failure), not from the removed `answer === "No"` re-throw, so turn-stop behavior for Esc is preserved automatically.
- Loop consequence: with no error thrown on "No", `processor.ts:377` no longer fires; the turn continues and the model can immediately ask what to refine.

### prompt.ts — short continuation reminder on plan→plan turns

In `SessionPrompt` where `input.agent.name === "plan"` and the previous assistant message is already `plan` (currently an early return at prompt.ts:810), inject a compact synthetic `<system-reminder>` on the user message instead of returning bare. Content (short, ~3 lines, to avoid token waste — user-directed):

- Plan mode is still active: read-only, the only writable file is the plan file at `${plan}` (or "create it at ${plan}" when absent).
- Refine the plan per the user's message.
- End the turn by either asking a question (`question` tool) or calling `plan_exit`.

The full plan-mode workflow reminder stays exclusive to the entry transition; this new one covers every subsequent plan turn.

**Dedup guard (required for correctness)**: `insertReminders` runs on EVERY loop step and persists parts via `updatePart`. The base code's entry branch was implicitly self-guarding — at step 2 the last assistant message is already plan, flipping the condition. The new plan→plan branch breaks that implicit guard: entry-turn step 2+ and continuation-turn step 2+ would both re-enter it and stack duplicate reminders into the DB (and shift the prompt prefix every step). The branch therefore skips injection when the user message already carries a part containing `"Plan mode is"` — matching both the full ("Plan mode is active") and short ("Plan mode is still active") variants. Regression test: `test/session/plan-reminder-dedup.test.ts` (multi-step entry turn + multi-step continuation turn each end with exactly one reminder).

**Upgrade compatibility / prefix cache**: no schema change; historic messages are never rewritten. For an in-flight plan session resumed after upgrade, the next plan→plan user message gains one extra synthetic part — a one-time incremental prefix-cache miss from that message onward (equivalent to any new user input), not a full-history invalidation. Subsequent turns append the reminder only on the newest message, so the historic prefix stays byte-stable and cacheable.

### Out-of-scope UI note

TUI strike-through rendering (`completed && metadata.switched === false`) is left as-is; it applies uniformly to No/feedback results and is cosmetic.

## [S3] Out of Scope

- Removing or redesigning plan mode itself (possible future direction; not this change).
- Esc/dismiss semantics and `continue_loop_on_deny` behavior.
- Hardening bash against writes in plan mode (existing "trust the model" stance).
- TUI rendering changes, i18n question text changes.

## Tasks

- [x] T1: Rework "No" and feedback branches in `PlanExitTool` and `PlanEnterTool` (`packages/opencode/src/tool/plan.ts`) — acceptance: replying "No" to either tool resolves successfully with `switched: false` and output containing continue-planning guidance (plan_exit output instructs asking the user what to refine via the question tool); feedback replies include a "mode unchanged, do not implement" reminder; rejecting (Esc) still fails with `QuestionRejectedError`; covered by new unit tests under `packages/opencode/test/tool/` (covers: S2)
- [x] T2: Inject short plan-continuation reminder for plan→plan turns in `packages/opencode/src/session/prompt.ts` — acceptance: when agent is `plan` and previous assistant message agent is `plan`, the outgoing user message gains one synthetic system-reminder naming the plan file path and the question/plan_exit turn-ending rule; entry transition still gets the full workflow reminder only; verified by unit test or, if the prompt pipeline is impractical to harness, by targeted inspection plus typecheck (covers: S2)
- [x] T3: Verify — acceptance: `bun typecheck` passes in `packages/opencode`; new and existing related tests (`test/tool/question.test.ts`, new plan tool tests, `test/agent/agent.test.ts`) pass from the package dir (covers: S2; depends: T1, T2)
