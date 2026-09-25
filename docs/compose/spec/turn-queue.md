---
feature: turn-queue
status: in-progress
updated: 2026-09-24
branch: feat/turn-queue
commits: 30e55a4e58c56044bea4dc9551a24395ef47e961..HEAD
diagrams:
  authoritative: turn-queue-rev3.svg
---

# Turn Queue

## Diagrams

- **Authoritative:** `turn-queue-rev3.svg` (approved rev3 target architecture). Intent kinds in the contract are only `prompt|resume|wake|shell` (no `system`).

## Report

### Combined delivery

Deliver A (Turn Queue foundation) and B (Subagent waiting) together in PR #2452, with B depending on A's admission and execution-ownership contracts. Keep their responsibilities and tests distinguishable within the combined change; passing composition tests alone does not prove every boundary. The Desktop rendering changes remain in the companion repository.

| Change | Responsibility | Excluded behavior |
|---|---|---|
| A — Turn Queue foundation | Durable admission, claim/extend/ack, frontier, user input revision, session epoch cancellation, HTTP/SDK/recovery contracts, and runtime ownership | No new automatic child-wait barrier or actor wait/run behavior |
| B — Subagent waiting | Actual execution liveness, orphan handling, automatic main waiting, interruptible and bounded wait/run, inline versus notification delivery, and waiting hints | No separate input queue, scheduler, or cancellation epoch |

A exposes level-triggered `observeInput`, the session epoch and guarded admission, receipt claim/extension/ack, and claim-aware dispatch. Execution-bound notification epoch guards belong to A even when their implementation resides in actor files. B consumes these contracts; its run notification decision and outcome handoff belong to B. CronBridge ownership and its fixture wiring belong to A because a second runtime must not replace the queue and Prompt service references; this does not claim that Cron hook delivery is durably admitted.

Review shared files by logical blocks, not by whole-file ownership. In particular, `prompt.ts`, `spawn.ts`, `notification.ts`, `inbox.ts`, and their tests contain both layers. Keep the combined engine worktree intact for PR #2452; Desktop rendering remains a companion change in a separate repository.

A's independent `test/session/turn-queue-admission.test.ts` covers late admission, claim-before-history-snapshot, non-regressing frontier, unadmitted input exclusion, admitted format changes, multi-batch tool continuation, and compaction without B's child-wait barrier. The existing mixed fixtures in `test/actor/main-wait.test.ts` remain as composition regressions. B retains the liveness, automatic wait, explicit wait/run, setup interruption, cancellation, result-contract, and notification-handoff tests.

Before accepting A, verify the HTTP receipt response and single abort epoch. The queued-caller cancellation regression is fixed by invalidating pre-cancel Runner waiters; they return the interrupted result without restarting old work. Synchronous resume retains BusyError priority; background resume reads real candidate freshness even while busy and returns NotFound only when that target is no longer recoverable. Tests retain same-assistant, no-hang, no-duplicate-execution, and no-post-cancel-restart assertions. Claim/abort races, restart reconciliation, and source-string migration checks still require focused verification. Passing B's integrated fixtures does not substitute for this acceptance.

Shell and resume retain exclusive, non-queued Runner ownership in A. Shell uses the permitted non-turn lease with the same session cancellation epoch. Resume preserves its existing exclusive launch and background admission handshake, with epoch checks before lease acquisition and before work. Neither path writes a receipt or re-enters via the queue scheduler; the incomplete admit/direct-execute/ack path is removed. Durable shell/resume scheduling remains deferred, not delivered. The heterogeneous Intent types below describe the target architecture, not a claim that these two public entrypoints currently admit work to it.

Acceptance: exercise A's admission/receipt/abort behavior, B's liveness/wait/notification behavior, and their interaction in the combined engine. The combined engine and Desktop require product E2E in the companion repository; TestLLMServer service integration and DOM exercises must remain labelled as such. Independent branch construction is not a prerequisite for this combined PR.

### B follow-up: Resume availability during subagent completion

Status: reported, not yet reproduced or fixed. This belongs to B — Subagent waiting and its Desktop companion, not to A's admission foundation.

Observed sequence: main stops while a subagent continues running; later the subagent stops. During the completion/handoff window, Desktop displays an enabled Resume button, but clicking it does not resume main. After a delay, main replies without another successful Resume action. The report does not yet establish whether explicit cancellation, natural completion, post-stop hooks, notification handoff, or stale UI projection causes the window; preserve and distinguish those cases during reproduction.

Required behavior and acceptance:

- Resume availability must reflect the engine's current recoverability and execution ownership, including subagent finalization, post-stop hooks, and pending notification handoff. Do not show an enabled action that silently cannot take effect.
- If a main execution already owns the session or an automatic continuation is in progress, show the actual running/waiting state instead of an actionable Resume. If explicit resume is valid, one click must start or attach to the intended continuation with visible acknowledgement; a raced rejection must reconcile the UI and explain the state rather than silently do nothing.
- Manual Resume racing with subagent completion must not launch duplicate main executions, duplicate replies, lose completion delivery, or cancel a still-running child. Preserve A's exclusive resume and cancellation-epoch contracts.
- Investigate whether the later automatic reply is permitted by the actual stop operation. Do not infer from this report that explicit cancellation authorizes automatic restart, or that all later completion notifications must be suppressed.
- Add engine lifecycle regressions and a real Desktop + engine E2E for the reported ordering, including slow post-stop cleanup, completion delivery before/after the click, repeated clicks, and reconnect/history recovery. Assert button state, request outcome, execution count, notification delivery, and eventual response; arbitrary sleeps or DOM-only injected states are not sufficient evidence.

## [S1] Problem

Turn admission is split across several ad-hoc paths on main (`30e55a4e58`):

- `SessionRunState.ensureRunning` / `Runner.ensureRunning`: live reentry attaches one **pending** slot and coalesces later callers onto the same Deferred; dead fibers are reclaimed. Admission and execution share one owner.
- `ensureExclusive` / `startOwned` / `start` / `startShell`: additional admission styles used by resume and shell.
- HTTP `POST /:sessionID/message`: `assertNotBusy` → **409** when busy. `POST /:sessionID/prompt_async` (TUI + App Desktop) has **no** busy guard and `prompt()` fire-and-forget (**204**).
- Subagent completion / inbox wake calls `loop` → `ensureRunning` (join or pending-attach), not a first-class “work arrived” Intent.
- Long-blocking tools (`actor wait`) freeze the lane; user input cannot steer until the tool returns.

**Invariant that must hold after this feature (test oracle):** every complete external input persisted by the trusted prompt path has a durable admission intent, then a receipt in `accepted|claimed|settled|cancelled|rejected`; boot closes a crash between these writes. A run may consume only its claimed inputs or explicitly recorded consumed history, regardless of message ID ordering. An input is never both consumed and left as a second pending admission, and never disappears without recoverable intent or terminal receipt.

## [S2] Design

### Goals

1. **One scheduling owner per lane** `(sessionID, agentID)`: mailbox, receipts, claim/ack, idle decision.
2. **Runner = exclusive execution/cancel only** (lease). No pending-slot admission.
3. **Heterogeneous Intents** with complete payloads and validation.
4. **Steer via monotonic `inputRevision`** (level-triggered + atomic check-and-subscribe).
5. **Cancel epoch** (session-scoped) fences dispatch; transport disconnect ≠ abort.
6. **Receipts are durable correctness state** (not optional P2).
7. TUI/Desktop keep `prompt_async` path; sync `/message` = admit + await receipt/stream.

### Main-turn completion and subagent liveness

A successful natural main-turn completion retains its Runner while any non-system, same-session subagent execution remains active. This also applies to structured-output success. Peer sessions and system actors are excluded. Explicit cancellation and error exits retain their existing semantics.

The barrier observes execution fibers and reservation completion, not just stored actor status. User prompt admission interrupts the wait without interrupting child execution; after handling that input, main waits again if children remain. Completion notifications are drained before final exit. A stale running row with no live execution is conditionally failed and reported to main; a newer execution or an already committed terminal outcome must not be overwritten. Silence only changes the waiting status message and never proves death.

Public actor status and wait use fresh registry metadata plus actual execution fibers, including the Runner fiber fallback. A reserved execution before attachment remains active; an exited fiber does not remain active merely because its execution record or busy ledger persists. A nonterminal row without execution projects to stopped without reusing its old outcome, error, delivery, or completion timestamp. Wait does not return completion while the execution is still finishing; timeout and steer return the latest snapshot without cancelling it. These reads do not mutate actor history.

An explicit actor wait timeout includes a model-facing hint without changing the requested timeout or cancelling the actor. Automatic main waiting uses the same default ten-minute deadline per waiting window, independent of child activity and the thirty-second display refresh. If children remain active at expiry, a synthetic main message lists them and carries the same hint, forcing a new model step in the existing Runner rather than silently waiting forever. New user input and already available terminal notifications take precedence. The hint recommends checking actual status and available evidence, requesting concrete progress or partial results, and cancelling when appropriate; it does not claim that activity proves progress or that the history tool can filter by actor. No periodic supervisor, trajectory summarizer, or automatic cancellation is introduced.

CronBridge startup, scheduled fires, and keepalive callbacks belong to the application graph that owns the mounted Prompt service. Mounting Cron must not initialize a second global AppRuntime or replace actor, prompt, or queue service references. Scheduled delivery retains the mount's Instance context and calls that Prompt instance; it preserves the existing hook path, not a claim of durable queue admission or priority enforcement. Start and scheduler teardown are serialized, while delivery scopes close outside the lifecycle lock so callback finalizers can re-enter safely. Stopped mounts cancel pending delivery and reject stale callbacks.

Claim expansion precedes the model-history snapshot, retains every receipt under the same run ID, and never lowers the frontier. A newly claimed prompt requires a model step even when its persisted ID predates the latest assistant. Hook turns that defer inbox processing must not claim external wake receipts.

The earlier delivery status is not a whole-PR acceptance result after rebase. HTTP admission, scheduler ownership, shell dispatch, and abort-epoch behavior still require separate full-migration validation.

### Admission inventory (target and compatibility exceptions)

Every current `SessionRunState` entry that occupies a Runner for a turn-like unit:

| API | Today | After |
|---|---|---|
| `ensureRunning` | pending-attach / join | Controller `admit` then exclusive lease |
| `ensureExclusive` | reject if busy | Resume compatibility exception: exclusive lease + epoch |
| `start` / `startOwned` | fork/occupy | Background resume compatibility exception: exclusive lease + epoch |
| `startShell` | main shell | Non-turn exclusive lease with same epoch; no durable receipt |
| `SessionPrompt.loop` | ensureRunning | only invoked **by** Controller with a claimed batch |
| inbox wake | loop | `admit({kind:"wake"})` |
| resume launch | ensureExclusive/startOwned | Retain exclusive compatibility contract; durable admission deferred |
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
  // Monotonic highest claimed/previously consumed prompt ID; not a membership test.
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
- Reconcile explicit pending admission intents, not every receipt-less user: current-epoch ready inputs receive `accepted` receipts; expired intents receive `cancelled/never_ran`. Any existing receipt is preserved. `dispatch:false` remains non-starting across restarts, while another ordinary turn may consume it in a batch.
- Pre-queue legacy membership is frozen during schema migration. Its answered inputs receive consumed historical receipts; unanswered inputs receive accepted receipts. A durable bootstrap marker prevents reclassifying post-queue holes as legacy on subsequent boots.
- In-memory-only receipts are **not** allowed once `admit` is on the HTTP path.

### Claim / ack protocol (vs runLoop)

Define **message frontier** on the lane’s main (or actor) slice using **`MessageID`** (branded ascending string; ordering is the ID order used everywhere else in `prompt.ts` — `id > frontier` is string/ID compare, not numeric):

- `lane.consumedFrontier: MessageID | undefined` — highest user/assistant message the controller has acked as processed for this lane.
- Eligibility is receipt-based: `accepted`, unsuspended, current epoch. A previously unconsumed prompt remains eligible even when its ID is below the frontier. A settled, consumed receipt for the same message prevents duplicate execution.
- **Claim:** Controller sets `claimFrontier = max(MessageID of claimed prompts, consumedFrontier)` under MessageID order and hands the run a `Claim { receipts, epoch, claimFrontier }`.
- **runLoop contract:** external users in the current lane require an owned or consumed receipt. The frontier is a monotonic watermark, not permission to consume every lower ID. Inherited context and internal synthetic/provenance messages retain their separate paths. New prompt batches are projected in receipt order after existing history; `delivery_message_id` persists the first model-step assistant for each batch so tool continuations and later runs reconstruct the same order. A visible delivery anchor reloads its input even if the input's old physical position was compacted; a compacted-away anchor does not revive the batch.
- **Ack points** (explicit hooks in `runLoop`, not inferred):
  1. After the assistant message for the turn is persisted (`finish` set), Controller `ack(claimFrontier)` and `settle` receipts.
  2. Mid-turn in-loop pickup of a **new** user message requires Controller `extendClaim` (new receipt claimed into the same runId, frontier extended) before the loop continues — otherwise the loop must end the turn and leave the message `accepted`.
- **Error/cancel mid-turn:** `ack` only through the last **persisted** assistant that answers part of the batch; remaining claimed prompts → `cancelled` + `outcome: never_ran` (default: **no auto-requeue** after a claimed failure; client re-admits with a new idempotency key).
- Remove Runner `pending` slot as a second consumer; `ensureRunning` pending-attach is deleted after T4.

### Prompt persist ↔ admit atomicity

`prompt()` currently writes the user message, then starts the loop (`prompt.ts` createUserMessage → loop). Under TurnQueue:

1. Persist the complete user message, all resolved parts, and trusted `queueAdmission: { epoch, ready: true, dispatch }` in one synchronous SQLite transaction. Read the epoch inside that transaction. Internal hook/spawn messages do not receive this marker.
2. **Immediately** `admit({ kind: "prompt", messageID }, { expectedEpoch })` in the same Effect (without awaiting execution). Live admission and crash recovery use the same captured epoch.
3. If the process stops between those transactions, boot reconstructs the receipt from the durable ready intent. Current-epoch inputs become accepted; expired inputs become cancelled/never_ran. No partial multipart request may become executable.
4. Only then may HTTP return 202/200-stream. `noReply` sets `dispatch:false` and stops after admission. Boot must not start a lane solely for such inputs, including after repeated restarts.

**Oracle:** a complete trusted external input is always recoverable through its ready intent or represented by a receipt. A terminal cancelled receipt is valid; silently dropping the input is not. Unknown post-queue receipt-less messages have no implicit execution authorization.

**Re-admit after cancelled/never_ran (default no-auto-requeue):** a client may admit the same existing message with a new idempotency key even below the high watermark. No message rewrite is required. Concurrent live admissions reuse one receipt; an already settled, consumed message also reuses its receipt rather than running twice.

### Queue state transport

Receipts travel with the session rather than being reconstructed from message order. Native exports capture the transcript and all queue tables in one database snapshot, including session epoch, lane frontier/revision, receipt state and first-delivery anchors, and frozen legacy membership. Native import preserves this durable state, rejects conflicting existing targets, and never starts a model as an import side effect. Importing a file is not a transfer of the source process's execution lease.

Queue mutations enter the existing session-aggregate SyncEvent sequence as changed-row deltas, committed in the same transaction as the mutation. Replay applies results only: it does not repeat admission/coalescing logic, bump revision again, or kick execution. Initial workspace restoration also carries a consistent full queue baseline for rows that predate queue sync events. Transcript replay and baseline installation must complete atomically before the target can execute; an old baseline must not overwrite a newer sequence. Live execution leases are not portable and active migration must be rejected or explicitly fenced, never silently duplicated.

Legacy and third-party imports without queue metadata explicitly register imported user content as terminal, consumed history with no claimed execution outcome. They remove source admission markers and do not infer pending work or success from transcript order. Re-import replaces only that importer's history records, preserving local continuation receipts.

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
- **Actor run** uses the same interruptible, bounded waiting semantics after obtaining a live execution handle, rather than joining the child inside spawn before installing the wait. Capture the main lane input revision before spawning so input admitted during setup is not missed. User steer returns `interrupted` with the actor id and latest snapshot, leaving the child alive; timeout returns the latest snapshot and the shared wait timeout hint, also without cancellation. Explicit abort still cancels the child, including aborts during setup. Successful inline results and failure/partial results remain based on the authoritative outcome after completion gates and post-stop work, not on an idle registry row.
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
| `ensureExclusive` / `startOwned` / `start` / `startShell` | Shell/resume compatibility leases with epoch checks; no second durable admission owner |
| `/message` 409 | 202/200 per table |
| `prompt_async` 204 | 202+receiptId (compat 204) |
| inbox `loop` | `admit(wake)` |
| disconnect → cancel | disconnect detach only |
| in-loop user continue | `extendClaim` or end turn |
| resume exclusive paths | Preserve Busy/freshness and handshake contract; durable resume deferred |

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
| `session/prompt.ts` shell | `startShell` | skip durable admission: non-turn exclusive lease + epoch |
| `session/prompt.ts` resume ensure | `ensureExclusive` | skip durable admission: retain Busy-first exclusive lease + epoch |
| `session/prompt.ts` resume owned | `startOwned` | skip durable admission: retain owned handshake + epoch |
| `session/prompt.ts` resume start | `start` | skip durable admission: retain background exclusive lease + epoch |
| `inbox/inbox.ts` wake | `loop` → ensureRunning | migrate → admit(wake) |
| `server/.../session.ts` | assertNotBusy / prompt routes | migrate → admit + receipt |
| `session/revert.ts` | assertNotBusy only | keep (not turn admission) |
| `actor/spawn.ts` | SessionRunState (cancel/status) | skip (cancel path) |

CI: fail new `ensureRunning` call sites outside allowlist (T8).

## [S5] PR #2452 scope (combined foundation and subagent waiting)

PR #2452 carries both A's scheduling foundation and B's dependent subagent waiting behavior. Shell/resume retain the compatibility leases described above; durable shell/resume dispatch is not part of this change. The separate Desktop companion is not included in this repository's PR.

**Delivered**
- LaneController + durable receipts + epoch + frontier + idempotency + same-messageID live reuse
- `inputRevision` / `observeInput` (check-subscribe-recheck) + ActorWaiter steer
- **C-01** runLoop claim/ack/extendClaim; Runner `ensureRunning` serializes (no pending-attach dual owner)
- **C-02** inbox admits wake Intent only (no dual `loop()` when TurnQueue is wired)
- **C-03 compatibility exception** shell/resume use one exclusive Runner owner with cancellation-epoch checks, not durable admission. Sync resume preserves BusyError priority; background resume preserves freshness-first validation and its admission handshake.
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
- [ ] T8 full target: inbox wake admission is implemented; durable resume/shell admission remains deferred. A retains the documented exclusive lease/epoch compatibility exceptions, including sync resume BusyError priority (covers: S2).
- [x] T9: `bun typecheck` pass; `bun test test/turn-queue/ test/effect/runner*.test.ts test/actor/spawn.test.ts` green; migration-contracts guards (covers: S2)
