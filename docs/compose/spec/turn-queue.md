---
feature: turn-queue
status: delivered
updated: 2026-09-21
branch: feat/turn-queue
commits: 30e55a4e58c56044bea4dc9551a24395ef47e961..HEAD
diagrams:
  authoritative: turn-queue-rev3.svg
---

# Turn Queue

## Diagrams

- **Authoritative:** `turn-queue-rev3.svg` (approved rev3 target architecture). Intent kinds in the contract are only `prompt|resume|wake|shell` (no `system`).

## Report

## [S1] Problem

Turn admission is split across several ad-hoc paths on main (`30e55a4e58`):

- `SessionRunState.ensureRunning` / `Runner.ensureRunning`: live reentry attaches one **pending** slot and coalesces later callers onto the same Deferred; dead fibers are reclaimed. Admission and execution share one owner.
- `ensureExclusive` / `startOwned` / `start` / `startShell`: additional admission styles used by resume and shell.
- HTTP `POST /:sessionID/message`: `assertNotBusy` → **409** when busy. `POST /:sessionID/prompt_async` (TUI + App Desktop) has **no** busy guard and `prompt()` fire-and-forget (**204**).
- Subagent completion / inbox wake calls `loop` → `ensureRunning` (join or pending-attach), not a first-class “work arrived” Intent.
- Long-blocking tools (`actor wait`) freeze the lane; user input cannot steer until the tool returns.

**Invariant that must hold after this feature (test oracle):** for a given lane, a user message with `id > consumedFrontier` always has a durable receipt in `accepted|claimed|settled|cancelled|rejected`. It is never both consumed by the run and left as a second pending admit that will run again, and never disappears without any receipt row.

## [S2] Design

### Goals

1. **One scheduling owner per lane** `(sessionID, agentID)`: mailbox, receipts, claim/ack, idle decision.
2. **Runner = exclusive execution/cancel only** (lease). No pending-slot admission.
3. **Heterogeneous Intents** with complete payloads and validation.
4. **Steer via monotonic `inputRevision`** (level-triggered + atomic check-and-subscribe).
5. **Cancel epoch** (session-scoped) fences dispatch; transport disconnect ≠ abort.
6. **Receipts are durable correctness state** (not optional P2).
7. TUI/Desktop keep `prompt_async` path; sync `/message` = admit + await receipt/stream.

### Admission inventory (must all go through Controller)

Every current `SessionRunState` entry that occupies a Runner for a turn-like unit:

| API | Today | After |
|---|---|---|
| `ensureRunning` | pending-attach / join | Controller `admit` then exclusive lease |
| `ensureExclusive` | reject if busy | Controller claim + lease (no call-site ensure) |
| `start` / `startOwned` | fork/occupy | Controller claim + lease |
| `startShell` | main shell | Controller `admit({kind:"shell"})` or document as non-turn lease with same epoch |
| `SessionPrompt.loop` | ensureRunning | only invoked **by** Controller with a claimed batch |
| inbox wake | loop | `admit({kind:"wake"})` |
| resume launch | ensureExclusive/startOwned | `admit({kind:"resume"})` |
| command / init / summarize | mixed | inventory task must list and route each; unlisted paths fail CI gate |

T1 includes a mechanical inventory of every `ensureRunning|ensureExclusive|startOwned|startShell|SessionRunState.start` call site under `packages/opencode/src`. No dual admission after T8.

### Lane, epoch, Intent schemas

```ts
type Lane = { sessionID: SessionID; agentID: string } // agentID "main" default

// Session-wide cancel epoch (NOT per-lane): abort(session) increments once;
// all lanes under the session observe the same epoch. Persisted on the session
// row; boot reads it so a restart cannot claim pre-abort Intents.
type Epoch = number

// inputRevision is a per-lane monotonic counter (number), distinct from MessageID.
// Bumped on every admit that can change what the lane should look at next:
// - prompt: always bump (user steer)
// - resume: never bump (resume is not user steer; it does not interrupt actor wait)
// - wake: never bump (wake is not user steer)
// Implementation: bumpsInputRevision() is true only for kind === "prompt".

type Intent =
  | {
      kind: "prompt"
      messageID: MessageID          // user message already persisted
    }
  | {
      kind: "resume"
      assistantID: MessageID
      plan: "user-resume" | "tool-resume"
      // Optimistic concurrency: compare to assistant message status at claim
      // time (same enum as MessageV2.Assistant / resume plan). Reject if changed.
      expectedAssistantStatus?: AssistantStatus
    }
  | {
      kind: "wake"
      receiverActorID: string       // defaults to lane.agentID
      // Exclusive upper bound of inbox row ids (ulid/string order) included.
      // Coalesce keeps the max watermark.
      inboxWatermark: string
    }
  | {
      kind: "shell"
      command: string
      // Must stay under the session directory when set; reject otherwise.
      cwd?: string
    }

// Validation failures → Receipt.state = "rejected" (never silently dropped).
// shell Intents get receipts like any other kind.
```

- **Wake coalescing only:** two `wake` Intents for the same lane merge to the higher `inboxWatermark`. `prompt`/`resume`/`shell` never coalesce.
- **Eligibility order** (not transcript reorder): user `prompt` > `resume` (user) > `wake` > `shell`. Wake cannot starve prompt.
- **Accepted tradeoff:** a continuous stream of user `prompt` admits can delay `wake` indefinitely. `wake` coalesces (max inbox watermark) so notifications are not lost, but parent-resume latency under sustained user input is unbounded by design. Do **not** add aging/heuristics unless a later requirement demands anti-starvation for wake.

### Receipts (durable)

```ts
type ReceiptState = "accepted" | "claimed" | "settled" | "cancelled" | "rejected"
type Receipt = {
  id: string
  idempotencyKey?: string
  lane: Lane
  state: ReceiptState
  intent: Intent
  epoch: Epoch                 // epoch at accept (persisted with receipt)
  runId?: number               // Runner id (number)
  // Highest MessageID this claim may treat as in-batch. Same branded type and
  // ordering as MessageID (ascending string IDs; compare with MessageID order,
  // never numeric coercion).
  claimFrontier?: MessageID
  consumed?: boolean
  outcome?: "success" | "assistant_error" | "interrupted" | "never_ran"
  messageId?: MessageID        // assistant result when settled success
  error?: string
}
```

**Transitions**

```text
accepted → claimed → settled (outcome success|assistant_error)
                  → cancelled (outcome interrupted|never_ran)
accepted → cancelled | rejected
claimed  → cancelled (cancel/epoch; consumed flag distinguishes never_ran vs interrupted)
```

- `settled` + `assistant_error` means the turn ran and the assistant message carries an error — not the same as `rejected`.
- **Batch:** one `runId` may claim N Intents. Each receipt is tracked separately. On run end: every claimed receipt gets a terminal state. Partial consumption: receipts whose messages were in `consumedFrontier` get `consumed: true`; if the run dies before seeing them, `never_ran` and they remain eligible only if policy requeues — **default: do not auto-requeue `never_ran` after a claimed failure; surface error; client re-admits with new idempotency key.**
- **Idempotency:** uniqueness is **per session** (`sessionID` + `idempotencyKey`). Concurrent `admit` with the same key: one insert wins (unique index); the other returns the same receipt. Retention ≥ 7d (match inbox GC spirit). No second prompt message.
- **Durability (correctness, not P2)**
- Persist receipts + idempotency index + `session.epoch` + `lane.consumedFrontier` (SQLite). `accepted|claimed` survive restart.
- On boot: load epoch first; any receipt with `epoch < session.epoch` that is still `accepted|claimed` → `cancelled` / `outcome: never_ran` (never re-claim pre-abort work). Then: `claimed` without a live run → `cancelled` + `never_ran` (requeue **wake only**). `accepted` at current epoch remain eligible.
- Reconcile orphan user messages: any main-slice user message after `consumedFrontier` without a receipt → synthetic `accepted` prompt receipt (see persist↔admit).
- In-memory-only receipts are **not** allowed once `admit` is on the HTTP path.

### Claim / ack protocol (vs runLoop)

Define **message frontier** on the lane’s main (or actor) slice using **`MessageID`** (branded ascending string; ordering is the ID order used everywhere else in `prompt.ts` — `id > frontier` is string/ID compare, not numeric):

- `lane.consumedFrontier: MessageID | undefined` — highest user/assistant message the controller has acked as processed for this lane.
- A `prompt` Intent is eligible iff its `messageID` is **after** `consumedFrontier` in MessageID order (or frontier is undefined).
- **Claim:** Controller sets `claimFrontier = max(MessageID of claimed prompts, consumedFrontier)` under MessageID order and hands the run a `Claim { receipts, epoch, claimFrontier }`.
- **runLoop contract:** the run may only treat user messages with `id` **≤ `claimFrontier`** as part of this turn (plus older history). It must **not** start a second consume of `id` after `claimFrontier` inside the same run without a new claim.
- **Ack points** (explicit hooks in `runLoop`, not inferred):
  1. After the assistant message for the turn is persisted (`finish` set), Controller `ack(claimFrontier)` and `settle` receipts.
  2. Mid-turn in-loop pickup of a **new** user message requires Controller `extendClaim` (new receipt claimed into the same runId, frontier extended) before the loop continues — otherwise the loop must end the turn and leave the message `accepted`.
- **Error/cancel mid-turn:** `ack` only through the last **persisted** assistant that answers part of the batch; remaining claimed prompts → `cancelled` + `outcome: never_ran` (default: **no auto-requeue** after a claimed failure; client re-admits with a new idempotency key).
- Remove Runner `pending` slot as a second consumer; `ensureRunning` pending-attach is deleted after T4.

### Prompt persist ↔ admit atomicity

`prompt()` currently writes the user message, then starts the loop (`prompt.ts` createUserMessage → loop). Under TurnQueue:

1. Persist user message (same as today).
2. **Immediately** `admit({ kind: "prompt", messageID })` in the **same** Effect (no await of the turn).
3. Receipt row is written in the same SQLite transaction as the message when possible; if two transactions are required, order is **message first, receipt second**, and boot reconcile **creates a synthetic `accepted` receipt** for any user message after `consumedFrontier` that has no receipt (closes the crash window).
4. Only then may HTTP return 202/200-stream. `noReply` stops after step 3.

**Oracle:** there is never a durable user message after `consumedFrontier` without a receipt in `accepted|claimed|settled|cancelled|rejected`. `cancelled` (including boot `never_ran`) is a valid terminal receipt for S1/S2 self-consistency; the message is **not** silently dropped.

**Re-admit after cancelled/never_ran (default no-auto-requeue):** client may `admit({ kind: "prompt", messageID: <same existing user message> }, newIdempotencyKey)`. Controller accepts a new receipt for the same `messageID` when the prior receipt is terminal `cancelled` and `messageID > consumedFrontier`. Do **not** require rewriting the user message. A second concurrent live receipt (`accepted|claimed`) for the same `messageID` is rejected.

### Steer

```ts
observeInput(lane, afterRevision: number): Effect<Revision>
// level-triggered: if revision > afterRevision already, resolve immediately
// else wait; implement as check + subscribe under one lock (no gap)
```

- `admit(prompt)` bumps `inputRevision` **synchronously before** returning the Receipt (and before wake).
- **ActorWaiter.wait** integration (replaces registry-only wait):
  1. Snapshot `rev = lane.inputRevision`.
  2. Race: actor terminal (`ActorStatusChanged` / registry) vs `observeInput(lane, rev)` vs timeout.
  3. On input: return `{ status: "interrupted", actor_id }` — **do not** cancel the subagent.
  4. Enclosing main run is **not** auto-settled; the tool result instructs the model; Controller `extendClaim` happens when runLoop continues, else turn ends and the new prompt stays `accepted`.
- No transcript “≥2 users” heuristic. No tool-private queue events required for steer.

### Cancel epoch and transport

- `abort(sessionID)` / `SessionPrompt.cancel` **always**:
  1. Increment persisted **session** `epoch`.
  2. Interrupt all Runners in the session (current behavior).
  3. Apply `queuedPolicy` to `accepted|claimed` receipts whose `epoch < newEpoch`:
     - **`drop` (default):** state → `cancelled`, `outcome: never_ran` (or `interrupted` if `consumed`).
     - **`keep-suspended`:** state → `cancelled` + `outcome: never_ran` **and** a side table / flag `suspended: true` so they are **not** eligible for claim. They do **not** stay `accepted` (that would contradict “cannot claim pre-abort work”). Reactivation requires an explicit client `admit` (new receipt).
  4. Response includes `epoch`.

Precedence: epoch fence always applies first; `keep-suspended` only changes **retention visibility**, never eligibility of the old-epoch receipt.

- **HTTP disconnect** on `/message` (and any stream): detach the stream consumer only. Admitted work lives in Controller/Runner scope (forked), **not** the request scope. Remove `signal → session.cancel` for disconnect; only explicit `POST /abort` cancels.

- **ActorWaiter lanes:** waiter runs in the **parent main lane** `(sessionID, "main")` while blocking on a child actor id. `observeInput` uses the **main** lane revision (user steer), not the child actor’s lane. Session abort cancels wait via Runner interrupt (existing); input steer only interrupts the wait tool.

### HTTP / SDK contract (explicit)

| Endpoint | Contract |
|---|---|
| `POST /session/:id/prompt_async` | **202** + `{ receiptId }` (preferred). One-release compat: **204** allowed with `Deprecation` header. TUI/App already fire-and-forget. |
| `POST /session/:id/message` | `admit(prompt)`. **Never 409 for busy.** If claim starts in-request and client still connected → **200 stream**. Else **202** + `{ receiptId }` and **end the response**. No “202 then stream on same body”. |
| `GET /session/:id/receipt/:receiptId` | **Required** (durable). Returns current Receipt. Clients that miss SSE must poll this after 202. |
| `POST /session/:id/abort` | body `{ queuedPolicy?: "drop" \| "keep-suspended" }`; response `{ epoch }`. |
| Events | `session.receipt.updated` `{ receiptId, state, outcome?, messageId? }` — best-effort live; **GET is the source of truth**. |

OpenAPI models 200/202/204 + Receipt schema; `packages/sdk/js` regen in the same change. Migration note: 202=queued → GET receipt / events; idempotency keys; abort explicit; disconnect ≠ abort.

### Mapping from current code

| Current | Target |
|---|---|
| `Runner.ensureRunning` pending | **Remove** admission; lease only |
| `ensureExclusive` / `startOwned` / `start` / `startShell` | Sole caller = LaneController |
| `/message` 409 | 202/200 per table |
| `prompt_async` 204 | 202+receiptId (compat 204) |
| inbox `loop` | `admit(wake)` |
| disconnect → cancel | disconnect detach only |
| in-loop user continue | `extendClaim` or end turn |
| resume exclusive paths | `admit(resume)` |

## [S3] Out of Scope

- Mid-stream token injection into an in-flight provider request.
- Multi-process / multi-instance lane ownership (single engine process owns lanes).
- Rewriting `actor` spawn/send protocol.
- Changing message/part storage schema beyond receipt tables.
- Perfect zero-strand under crash without receipt persistence (persistence is in scope; exotic distributed crashes are not).

## [S4] T0 Admission inventory (living table)

Filled during T0; every row must be `migrate` or `skip` before T8.

| Call site | API | Decision |
|---|---|---|
| `session/prompt.ts` loop main path | `ensureRunning` | migrate → Controller claim |
| `session/prompt.ts` loop notifyParent path | `ensureRunning` | migrate → Controller |
| `session/prompt.ts` shell | `startShell` | migrate → admit(shell) or lease+epoch |
| `session/prompt.ts` resume ensure | `ensureExclusive` | migrate → admit(resume) |
| `session/prompt.ts` resume owned | `startOwned` | migrate → admit(resume) |
| `session/prompt.ts` resume start | `start` | migrate → admit(resume) |
| `inbox/inbox.ts` wake | `loop` → ensureRunning | migrate → admit(wake) |
| `server/.../session.ts` | assertNotBusy / prompt routes | migrate → admit + receipt |
| `session/revert.ts` | assertNotBusy only | keep (not turn admission) |
| `actor/spawn.ts` | SessionRunState (cancel/status) | skip (cancel path) |

CI: fail new `ensureRunning` call sites outside allowlist (T8).

## [S5] This PR scope (full scheduling migration)

PR #2452 ships the **full T3/T4/T8 migration** (C-01…C-10), not a foundation-only slice.

**Delivered**
- LaneController + durable receipts + epoch + frontier + idempotency + same-messageID live reuse
- `inputRevision` / `observeInput` (check-subscribe-recheck) + ActorWaiter steer
- **C-01** runLoop claim/ack/extendClaim; Runner `ensureRunning` serializes (no pending-attach dual owner)
- **C-02** inbox admits wake Intent only (no dual `loop()` when TurnQueue is wired)
- **C-03** resume/shell admit into Controller; resume routes no longer 409 on busy
- **C-04** `prompt_async` → **202 + receiptId** (Deprecation: 204)
- **C-06** `reconcileOnBoot` on prompt entry + wake requeue kick; abort cancels receipts before runner teardown
- **C-08** `/message` busy → admit + **202** (no assertNotBusy TOCTOU 409)
- **C-09** TUI recover no longer blocks on status.busy
- **C-10** OpenAPI: `/message` 202 schema, `prompt_async` 202, typed GET receipt
- HTTP disconnect does not abort; abort `{ok,epoch}` + `queuedPolicy`

**Accepted residual**
- Milliseconds-wide runner exit-tail race (from prior review) remains accepted.
- `execution-integration` “inbox waits for the entire spawn execution…” fails on origin/main as well (pre-existing; not a turn-queue regression).
- spawn/hook `prompt()` does not admit (actor system schedules those slices); `requireClaim` is only set for user/main admitted prompts and Controller kicks.

## Tasks

- [x] T0: **Admission inventory** — acceptance: table of every call site with migrate/skip (covers: S2)
- [x] T1: LaneController + Mailbox + durable Receipt + epoch + frontier + idempotency — acceptance: unit tests (covers: S2; depends: T0)
- [x] T2: inputRevision + observeInput — acceptance: level-triggered resolve; wake does not steer (covers: S2; depends: T1)
- [x] T3: Claim/ack + MessageID frontier + extendClaim **inside runLoop** — claim/ack wrap in loop(); mid-turn extendClaim on lastUser > claimFrontier (covers: S2; depends: T1)
- [x] T4: Runner exclusive-lease only — pending-attach removed; ensureRunning serializes behind a live run (covers: S2; depends: T3)
- [x] T5: SessionPrompt.prompt admits durable receipt for main user prompts; loop() settles via claim/ack (covers: S2)
- [x] T6: HTTP busy 202+receiptId, GET receipt, abort `{ok,epoch}` + `queuedPolicy`; `prompt_async` 202+receiptId; `/message` 202 OpenAPI; typed GET receipt (covers: S2)
- [x] T7: ActorWaiter observeInput on main lane — integration test: user admit interrupts wait; actor not cancelled (covers: S2)
- [x] T8: inbox admits wake Intent only (no dual loop); resume/shell on admit; resume no longer 409 (covers: S2)
- [x] T9: `bun typecheck` pass; `bun test test/turn-queue/ test/effect/runner*.test.ts test/actor/spawn.test.ts` green; migration-contracts guards (covers: S2)
