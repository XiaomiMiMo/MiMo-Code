---
feature: turn-queue
status: designed
updated: 2026-09-20
branch: feat/turn-queue
commits: 30e55a4e58c56044bea4dc9551a24395ef47e961..75c097c9a8
---

# Turn Queue

## Report

## [S1] Problem

Turn admission is split across several ad-hoc paths on main (`30e55a4e58`):

- `SessionRunState.ensureRunning` / `Runner.ensureRunning`: live reentry attaches one **pending** slot and coalesces later callers onto the same Deferred; dead fibers are reclaimed. Admission and execution share one owner.
- `ensureExclusive` / `startOwned` / `start` / `startShell`: additional admission styles used by resume and shell.
- HTTP `POST /:sessionID/message`: `assertNotBusy` → **409** when busy. `POST /:sessionID/prompt_async` (TUI + App Desktop) has **no** busy guard and `prompt()` fire-and-forget (**204**).
- Subagent completion / inbox wake calls `loop` → `ensureRunning` (join or pending-attach), not a first-class “work arrived” Intent.
- Long-blocking tools (`actor wait`) freeze the lane; user input cannot steer until the tool returns.

**Invariant that must hold after this feature (test oracle):** for a given lane, a user message with `id > consumedFrontier` is either (a) inside the currently claimed batch, (b) in the mailbox as `accepted`, or (c) already acked — never both consumed by the run and left as a second pending admit that will run again, and never dropped without a receipt in `settled|cancelled|rejected`.

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
// all lanes under the session observe the same epoch. Rationale: current
// cancel already interrupts every runner under the session.
type Epoch = number

type Intent =
  | {
      kind: "prompt"
      messageID: MessageID          // user message already persisted
      partsRef?: never
    }
  | {
      kind: "resume"
      assistantID: MessageID
      plan: "user-resume" | "tool-resume"
      // Optimistic concurrency: reject if the assistant is no longer the
      // resume target (status changed) — value from planResume at admit time.
      expectedAssistantStatus?: string
    }
  | {
      kind: "wake"
      receiverActorID: string       // defaults to lane.agentID
      inboxWatermark: string        // exclusive upper bound of inbox ids included
    }
  | { kind: "shell"; command: string; cwd?: string }

// Validation failures → Receipt.state = "rejected" (never silently dropped).
```

- **Wake coalescing only:** two `wake` Intents for the same lane merge to the higher `inboxWatermark`. `prompt`/`resume`/`shell` never coalesce.
- **Eligibility order** (not transcript reorder): user `prompt` > `resume` (user) > `wake` > `shell`/system. Wake cannot starve prompt.

### Receipts (durable)

```ts
type ReceiptState = "accepted" | "claimed" | "settled" | "cancelled" | "rejected"
type Receipt = {
  id: string
  idempotencyKey?: string
  lane: Lane
  state: ReceiptState
  intent: Intent
  epoch: Epoch                 // epoch at accept
  runId?: number               // Runner id (number)
  // inputRevision snapshot the run must treat as its consumption ceiling for
  // this claim; ack advances lane.consumedFrontier to this value only for
  // messages actually processed.
  claimFrontier?: number
  // True if the run started consuming (saw the user/assistant in msgs).
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
- **Idempotency:** `admit` with same `idempotencyKey` returns the existing receipt (any state). No second prompt message.

**Durability (correctness, not P2)**

- Persist receipts + idempotency index (SQLite): `accepted|claimed` survive process restart.
- On boot: reconcile — messages/inbox remain source of payload truth; receipts `claimed` without a live run → `cancelled` + `outcome: never_ran` (or requeue wake only). `accepted` remain eligible.
- In-memory-only receipts are **not** allowed once `admit` is on the HTTP path.

### Claim / ack protocol (vs runLoop)

Define **message frontier** on the lane’s main (or actor) slice:

- `lane.consumedFrontier`: highest `MessageID` the controller has acked as processed for this lane.
- A `prompt` Intent is eligible iff its `messageID > consumedFrontier`.
- **Claim:** Controller sets `claimFrontier = max(messageIDs of claimed prompts, last acked)` and hands the run a `Claim { receipts, epoch, claimFrontier }`.
- **runLoop contract:** the run may only treat user messages with `id ≤ claimFrontier` as part of this turn (plus older history). It must **not** start a second consume of `id > claimFrontier` inside the same run without a new claim.
- **Ack points** (explicit hooks in `runLoop`, not inferred):
  1. After the assistant message for the turn is persisted (`finish` set), Controller `ack(claimFrontier)` and `settle` receipts.
  2. Mid-turn in-loop pickup of a **new** user message requires Controller `extendClaim` (new receipt claimed into the same runId) before the loop continues — otherwise the loop must end the turn and leave the message `accepted`.
- **Error/cancel mid-turn:** `ack` only the portion already represented by persisted messages up to the last completed assistant; remaining claimed prompts → `cancelled`/`never_ran` per above.
- Remove Runner `pending` slot as a second consumer; `ensureRunning` pending-attach is deleted after T3.

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

- `abort(sessionID)` / `SessionPrompt.cancel`: increment **session** `epoch`; interrupt all Runners in the session (current behavior); mark all `accepted|claimed` receipts on those lanes `cancelled` (`consumed` preserved). Old-epoch Intents cannot be claimed.
- `queuedPolicy` on abort: `drop` (default) | `keep-suspended` (receipts stay `accepted` but blocked until a **new** explicit re-admit — not auto-run).
- **HTTP disconnect** on `/message` (and any stream): detach the stream consumer only. The admitted work lives in Controller/Runner scope (forked), **not** the request scope. Today’s `signal → session.cancel` is removed for disconnect; only explicit `POST /abort` cancels.

### HTTP / SDK contract (explicit)

| Endpoint | Contract |
|---|---|
| `POST /session/:id/prompt_async` | **202** + `{ receiptId }` (preferred). Compatibility: if body ignored, **204** still allowed for one release with a deprecated header. TUI/App: update to optional receiptId; they already treat as fire-and-forget. |
| `POST /session/:id/message` | `admit(prompt)`. **Never 409 for busy.** If the claim starts within the request and the client is still connected, **200 stream** the turn. If not claimed immediately, **202** + `{ receiptId }` **and end the HTTP response** — client continues via SSE `session.receipt.updated` / messages. No “202 then stream on same body”. |
| `GET /session/:id/receipt/:receiptId` | Optional; or document event-only. |
| `POST /session/:id/abort` | body `{ queuedPolicy?: "drop" \| "keep-suspended" }`; response includes `epoch`. |
| Events | `session.receipt.updated` `{ receiptId, state, outcome?, messageId? }`. |

OpenAPI + `packages/sdk/js` regen required in the same change as route behavior. Migration note for external SDK users: 202=queued, await receipt/events, idempotency keys, abort explicit.

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

## Tasks

- [ ] T0: **Admission inventory** — acceptance: table of every Runner/loop call site in `packages/opencode/src` with migrate/skip decision; PR checklist blocks unlisted `ensureRunning` for turn work (covers: S2)
- [ ] T1: LaneController + Mailbox + durable Receipt store + idempotency — acceptance: unit tests admit/claim/settle/cancel/reject; restart reloads `accepted|claimed`; wake coalesces; prompt never coalesces (covers: S2; depends: T0)
- [ ] T2: inputRevision + observeInput atomic check-and-subscribe — acceptance: no missed pre-subscribe bump; level-triggered resolve (covers: S2; depends: T1)
- [ ] T3: Claim/ack protocol wired into runLoop — acceptance: tests for full batch settle, partial error `never_ran`, extendClaim mid-turn, no Runner pending-attach (covers: S2; depends: T1)
- [ ] T4: Runner exclusive-lease only — acceptance: concurrent claim cannot double-run; finish does not start unknown work (covers: S2; depends: T3)
- [ ] T5: SessionPrompt.prompt/loop via Controller — acceptance: sync prompt = admit+await receipt; noReply = admit-only; orphan sweep preserved (covers: S2; depends: T3–T4)
- [ ] T6: HTTP message + prompt_async + abort/epoch + disconnect detach — acceptance: no busy 409; 202 vs 200 rules; disconnect does not abort; OpenAPI+SDK regen (covers: S2; depends: T5)
- [ ] T7: ActorWaiter observeInput race — acceptance: user prompt during wait → interrupted; subagent not cancelled; no transcript heuristics (covers: S2; depends: T2, T5)
- [ ] T8: inbox/wake + resume + shell through admit — acceptance: all T0 rows migrated; e2e races: concurrent prompt/resume/wake, cancel during claim, disconnect mid-turn, wake not starving user (covers: S2; depends: T1–T7)
- [ ] T9: Report fill + verification evidence — acceptance: commands+results recorded; duplicate-consumption oracle test included (covers: S1, S2)
