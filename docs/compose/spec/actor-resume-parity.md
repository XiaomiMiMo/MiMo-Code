---
feature: actor-resume-parity
status: delivered
updated: 2026-08-31
branch: fix/actor-resume-parity
commits: 91b2eb204a..1b481df6e3
---

# Actor resume parity with main agent

## Report

**What was built** — `Actor.runAgentLoop` now treats a retryable settled assistant error the same way the main agent's Resume path does: one automatic `SessionPrompt.resume` on the recovery candidate. If resume succeeds the actor completes with that turn's output; if resume is unavailable the original `AssistantSettledError` classification is preserved. Non-retryable failures (overflow / auth / aborted) still fail immediately. No spawn-layer retry budget was added.

**Verification** — `cd packages/opencode && bun test test/actor/spawn.test.ts` → 32 pass (includes new auto-resume success test; existing classification tests still pass). `bun run typecheck` clean.

**Journey log** — User required actor retry strategy to match main agent, not a divergent spawn re-run. Shared session retry already applies via `sessionPrompt.prompt`; the real gap was missing auto-resume after exhaust. `resumeBackground` is fire-and-forget and cannot return the resumed turn, so blocking `SessionPrompt.resume` is the correct parity call. Mock assistants must omit `time.completed` to be recovery candidates (engine pin PR #2279).

## [S1] Problem

Background actors (`Actor.spawn` subagents) share the main agent's session-level retry ladder (`session/retry.ts`). When that budget exhausts on a transient API error (e.g. `rate_limit_check_failed` 500), the assistant settles with an error and **no** `time.completed` — the same shape the engine exposes as a `/recovery` candidate and the desktop Resume path continues.

Main agent: user can hit Resume → `SessionPrompt.resume` continues the interrupted turn.

Actor: `runAgentLoop` immediately raised `AssistantSettledError` and failed the actor. Parent got a terminal `failed` notification; work died even though a resumable recovery candidate was sitting there.

## [S2] Design

- **Do not invent a spawn-layer retry budget.** Actor LLM calls already go through `sessionPrompt.prompt` → the shared retry policy. Parity means: after a retryable settle, use the **same** recovery turn as main (`SessionPrompt.resume` on the recovery candidate), not a divergent re-run loop.
- `runAgentLoop` loops at most **once**:
  1. `prompt` → if assistant has error and `classifyAssistantError(...).retryable` → attempt `resume(assistantMessageID)`.
  2. If `resume` succeeds, take its result as the turn output.
  3. If `resume` fails (NotFound / Busy / …), fall back to `AssistantSettledError` with the **original** classification — resume unavailability must not mask the cause.
  4. Second retryable settle (or non-retryable) still fails with classification.
- Non-retryable failures (overflow / auth / aborted) are unchanged: fail immediately, no resume attempt.

## [S3] Out of Scope

- Changing session-level retry budgets or classification tables.
- Auto-resume loops larger than one attempt.
- Desktop Resume UI (covered by mimo-desktop `session-resume` D16c).

## Tasks
- [x] T1: runAgentLoop auto-Resume once for retryable settled errors — acceptance: transient 429 settle + successful resume → actor outcome success; resume unavailable → original APIError classification preserved (covers: S2)
- [x] T2: regression tests in spawn.test.ts — acceptance: existing classification tests still pass; new auto-resume success test passes (covers: S2; depends: T1)
