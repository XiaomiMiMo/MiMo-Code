---
feature: turn-queue
status: designed
updated: 2026-09-20
branch: feat/turn-queue
commits: 30e55a4e58c56044bea4dc9551a24395ef47e961..30e55a4e58c56044bea4dc9551a24395ef47e961
---

# Turn Queue

## Report

## [S1] Problem

Turn admission is split across several ad-hoc paths:

- `SessionRunState.ensureRunning` / `Runner.ensureRunning`: live reentry attaches one **pending** slot and coalesces later callers onto the same Deferred; dead fibers are reclaimed. This is both admission and execution.
- `ensureExclusive` / `startOwned` (R003/C001): resume already refuses to join an unrelated run — a second, parallel admission style.
- HTTP `POST /:sessionID/message`: `assertNotBusy` → 409 when busy; clients must poll/retry. `POST /:sessionID/prompt_async` (TUI + App Desktop) has **no** busy guard and fires `prompt()` fire-and-forget (204).
- Subagent completion / inbox wake calls `loop` → `ensureRunning`, joining or pending-attaching rather than representing “work arrived”.
- Long-blocking tools (`actor wait`) freeze the lane; user input cannot steer until the tool returns. Stopgaps (event + transcript heuristics) do not scale.

Consequences: dual completion authority (Runner pending vs route 409), lost or double-consumed user input vs in-loop pickup, no first-class receipts, cancel/transport coupling, and steer that is tool-specific instead of lane-level.

## [S2] Design

### Goals

1. **One scheduling owner per lane** `(sessionID, agentID)`: mailbox selection, run identity, completion receipts.
2. **Runner = exclusive execution/cancel only** (lease), not silent queueing.
3. **Heterogeneous Intents**, not a single priority queue of “turns”.
4. **Steer via monotonic `inputRevision`** (level-triggered), not mailbox head and not transcript heuristics.
5. **Cancel epoch** fences future dispatch; transport disconnect ≠ abort.
6. TUI/Desktop keep `prompt_async`; sync `POST /message` becomes `admit` + await receipt.

Non-goals are in [S3].

### Lane and ownership

```text
Lane = { sessionID, agentID }

admit(lane, intent, idempotencyKey?) → Receipt
  Intent =
    | { kind: "prompt"; messageID }          // durable user message already written
    | { kind: "resume"; assistantID; expectedRevision }
    | { kind: "wake"; inboxWatermark }       // coalescable hint
    | { kind: "command"; commandID }         // optional later
```

- **LaneController** (one live controller per lane, in-process): owns Mailbox, `inputRevision`, `epoch`, claim/ack, and the decision “more work vs idle”.
- **Runner** (existing `effect/runner.ts`): acquires an exclusive lease; if occupied, **rejects**. No pending-slot admission. Finalizer barrier / orphan sweep stay as today.
- Controllers are the only callers of `Runner.ensureExclusive` / start-with-lease. External `ensureRunning` call sites migrate to `admit`.

### Receipts

```ts
type ReceiptState = "accepted" | "claimed" | "settled" | "cancelled" | "rejected"
type Receipt = {
  id: string
  lane: Lane
  state: ReceiptState
  intentKind: Intent["kind"]
  messageId?: MessageID
  runId?: string
  epoch: number
  consumedFrontier?: number  // inputRevision at claim
  error?: string
}
```

- `accepted` → durable work (or in-memory schedule + durable payload already in DB).
- `claimed` → Controller handed a batch to Runner; records `runId` + `epoch` + frontier.
- `settled` → run finished (success or assistant error); `cancelled` → epoch/cancel; `rejected` → validation/busy-policy deny.
- **Idempotency**: same `idempotencyKey` returns the same receipt; no double prompt.

### Claim batch (unit of consumption)

- A run **claims** a bounded set of Intents (and/or message-id range) at start of an iteration or turn.
- Controller **acks** that frontier only when the run has consumed those messages (iteration end / tool-return boundary).
- In-loop newer-user pickup (`runLoop` continue) must **ack via Controller**, not invent a second consumer. Priority only selects **eligible** intents; it does not reorder transcript messages.

### Steer

```ts
observeInput(lane, afterRevision: number) → AwaitableRevision
// resolves when inputRevision > afterRevision (level-triggered)
```

- `admit` of user-bearing intents (`prompt`) increments `inputRevision` **before** wake.
- Yield-capable tools (`actor wait`, future long waits) call `observeInput(lane, snapshotRev)` **and** check-and-subscribe atomically (no gap).
- On resolve: tool returns `{ status: "interrupted" }`; actor/work continues unless separately cancelled.
- Replaces: `PromptQueued` bus special-case, “≥2 users after last finished assistant” heuristics, wait-only transcript scans.

### Cancel and epoch

- `abort` / `cancel(sessionID)` increments lane `epoch` (or session epoch shared by lanes).
- Intents/receipts with `epoch < current` are not claimed; policy: `drop` | `keep-suspended` (explicit).
- Terminal notifications from an old epoch may remain durable but **must not** auto-start work.
- HTTP client disconnect must **not** cancel the session turn (today it does). Disconnect only detaches the streaming consumer.

### Dependency and fairness

- Lanes are independent; main does not serialize all agents.
- Maintenance (checkpoint writer, etc.) that main **awaits** must inherit priority or reserve capacity — “system always lowest” is forbidden when it inverts.
- Wake Intents may coalesce (`inboxWatermark`); `prompt`/`resume` never coalesce.
- Fairness: wake traffic cannot starve user prompts indefinitely (user class wins when both eligible).

### API / SDK surface

| Surface | Change |
|---|---|
| `POST /session/:id/prompt_async` | Keep path. Internally `admit(prompt)`. Still **204** (or **202** + `receiptId` — prefer 202 once TUI/App can ignore body). TUI + App already use this. |
| `POST /session/:id/message` | Keep sync stream. Busy: **202 queued** + receipt, or wait until claimed and stream. No 409 for busy. |
| `POST /session/:id/abort` | Optional `queuedPolicy`; returns `epoch`. |
| Events | Add `session.receipt.updated`. Deprecate/stop inventing tool-specific queue events. |
| JS SDK | Regen after OpenAPI; document 202/204 + receipt await pattern. |
| Internal `SessionPrompt.prompt` | Signature may stay `Effect<WithParts>`; implementation = `admit` + await `receipt.settled`. `noReply` becomes admit-only. |

TUI/Desktop: **no client path rewrite**; they already fire-and-forget `prompt_async` and listen to events.

### Mapping from current code (main @ 30e55a4e58)

| Current | Target |
|---|---|
| `Runner.ensureRunning` pending attach | Remove as admission; keep exclusive lease only |
| `ensureExclusive` / `startOwned` (resume) | Become the **only** Runner entry; Controller is sole caller |
| `assertNotBusy` + 409 on `/message` | `admit` + receipt; 409 only for non-busy validation if any |
| `prompt_async` → `prompt()` | `admit` + 204/202 |
| inbox `loop` wake | `admit({kind:"wake"})` |
| disconnect → `session.cancel` | disconnect only |
| in-loop user pickup | claim/ack through Controller |

### Durability

- Message payloads stay in the message DB (already durable).
- Receipts: P1 in-memory OK **if** restart reconciles from messages + inbox; P2 persist receipts.
- Inbox already persists before wake; keep that. Distinguish **accepted** vs **executed**.

## [S3] Out of Scope

- Mid-stream injection into an in-flight provider request.
- Cross-process distributed queue / multi-instance lane ownership.
- Rewriting the `actor` tool protocol (spawn/wait/send stay).
- Changing message/part read models or share/public surfaces.
- Auto-migrating external SDK users beyond documented 202/receipt notes.

## Tasks

- [ ] T1: LaneController + Mailbox + Receipt types and in-memory impl — acceptance: unit tests for admit/claim/ack/settle/idempotency/coalesce-wake (covers: S2)
- [ ] T2: inputRevision + observeInput with atomic check-and-subscribe — acceptance: no missed pre-subscribe bump; test (covers: S2; depends: T1)
- [ ] T3: Runner exclusive-lease only; remove pending-slot admission — acceptance: concurrent admit cannot double-run; finish does not silently start unknown work (covers: S2; depends: T1)
- [ ] T4: Migrate SessionPrompt.prompt / loop to admit+await receipt — acceptance: sync prompt returns assistant via receipt; noReply = admit-only (covers: S2; depends: T1–T3)
- [ ] T5: HTTP message + prompt_async + abort/epoch + disconnect fix — acceptance: busy message 202/receipt; prompt_async admits; disconnect does not abort; SDK regen (covers: S2; depends: T4)
- [ ] T6: actor wait uses observeInput — acceptance: user prompt during wait → interrupted without transcript heuristics (covers: S2; depends: T2)
- [ ] T7: inbox/wake and resume route through admit — acceptance: wake coalesces; resume exclusive admission via controller not ad-hoc ensureExclusive at call sites (covers: S2; depends: T1–T4)
- [ ] T8: Migration cleanup — acceptance: no PromptQueued-style stopgaps; docs/spec Report filled; typecheck + targeted tests (covers: S2)
