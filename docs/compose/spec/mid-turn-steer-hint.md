---
feature: mid-turn-steer-hint
status: delivered
updated: 2026-09-01
branch: mid-turn-steer-hint
commits: d17e176ba1..fa396138c7ae863acd8e201dc8f119ea79730974
---

# Mid-turn Steer Hint

## Report

**What was built** — At the `runLoop` message-load checkpoint, inject a short in-memory `<system-reminder>` only for **unanswered mid-turn steers**: real user prose written while the prior same-session assistant was still open, with no later assistant yet answering it. Anchor to the last real user so `inbox.drain` synthetics cannot hide a steer. Once an assistant exists after that user it is the current turn and is not re-injected. Multi-steer pile-up is named by count only (bodies stay in the transcript). Ordinary sequential turns after a finished reply never fire (keeps the frozen model-request prefix). No desktop UI, Runner, or compose-next skill changes.

**Verification** — From `packages/opencode` in the worktree: `bun typecheck` PASS. `bun test test/session/steer-hint.test.ts` — 13 pass. `bun test test/session/steer-multi.integration.test.ts` — PASS. `bun test test/session/prompt-effect.test.ts -t "uses the frozen system and appends the compaction prompt"` — PASS.

**Journey log**

1. First attempt scoped the hint to compose-next skill body — wrong product surface. Correct surface is general mimocode steer at the loop message checkpoint.
2. Sequential-turn injection broke compaction frozen-prefix equality; tightened to mid-turn / stacked only.
3. Review + design discussion: steer is only a user written while the prior assistant is open; once an assistant answers it, it is the current turn (like user1). Unanswered + open-window + last-real-user anchor.
4. Integration test must poll the DB for steers before releasing the first LLM step — wall-clock sleep races under CI load.

## [S1] Problem

When a user message is sent while the session runner is busy (`prompt_async`), the engine persists the user message first; `ensureRunning` waits on the existing runner. On the next `runLoop` iteration the new message becomes `lastUser` and can be treated as a wholesale task switch.

Models routinely abandon in-progress work. Example session `ses_-ffe5fa415ff27ffeUQ7TFo3dF`: tool-name research was dropped for "帮我安装一下" and later chrome/IAB notes, although the user expected addition, not replacement.

True mid-turn steer is picked up in the **gap between tool-call steps** (the loop reloads messages after a non-final step). Desktop `followup=queue` drains one follow-up at a time after idle; multi-message mid-turn pile-up is several `prompt_async` calls while busy.

## [S2] Design

### Steer definition

A **steer** is a real user message that:

1. Has non-synthetic, non-ignored text prose.
2. Was created while the previous **same-session** assistant was still open:  
   `assistant.time.created ≤ user.time.created` and (`assistant.time.completed` unset or `user.time.created ≤ assistant.time.completed`).
3. Is still **unanswered**: no same-session assistant exists **after** it in the transcript.

Once an assistant exists after that user, it is the current turn (same status as the first user of that turn) — not a pending steer.

Parent assistants inherited via `contextFrom` (different `sessionID`) do not count.

Synthetic-only users (inbox.drain, goal re-entry, auto-continue) never count as steers. The hint anchors to `lastRealUserMessage` so a newer synthetic user cannot hide a real steer.

Several real users stacked after the last same-session assistant all count as pending.

### Injection point

At the `runLoop` message-load checkpoint, attach an **in-memory** synthetic `<system-reminder>` to the last real user message when `shouldInjectSteerHint` is true. Not persisted. Reload each iteration prevents stacking. Do not rewrite user prose or invent a second message.

### Hint text

- One pending:  
  `This user message comes after earlier work in the conversation — keep that work unless the message clearly replaces it.`
- N > 1 pending:  
  `There are N unanswered user messages after your last reply (including this one), already in order above. Handle all of them together. Keep earlier work unless one of them clearly replaces it.`

No compose-next coupling. No re-embedding of message bodies.

### Out of engine paths

- No desktop followup UI / settings change.
- No `prompt_async` / `assertNotBusy` / Runner semantic change.
- No compose-next skill body change.

## [S3] Out of Scope

- Changing when steer vs queue is used.
- Interrupting the in-flight runner when a steer arrives.
- Persisting structured intent-class decisions.
- Localizing the reminder body.
- Changing inbox.drain content.

## Tasks

- [x] T1: Add `session/steer-hint.ts` (detector + notice + last-real-user anchor) — acceptance: unit tests for first-turn skip, sequential skip, open-window fire, unanswered skip when assistant follows, stacked fire, synthetic anchor (covers: S2)
- [x] T2: Wire into `runLoop` message checkpoint on last real user — acceptance: in-memory only; frozen-prefix compaction test still passes (covers: S2)
- [x] T3: Multi-steer integration test — acceptance: holds first LLM step until two steers are in the DB, then asserts unanswered-count hint (covers: S2)
