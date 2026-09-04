---
feature: loop-streak-recovery
status: delivered
updated: 2026-08-28
branch: feat/loop-streak-recovery
commits: f02ee661a6..e5c9ba229b
---

# Loop Streak Recovery

## Report

**What was built** — Request-layer loop-streak crop behind `experimental.loop_streak_recovery`, aligned with turn recovery: no new user, `lastUser`/`parentID` unchanged, span persisted as an `ignored`+`synthetic` part on the existing parent user. Detection is thinking-primary (tools may drift). Spans re-apply on every later request until the feature is off. Cropped assistants stay in the DB; model-facing stream has no loop/recovery wording. `max_span` ceiling (default 64).

**Verification** — `bun typecheck` PASS; `bun test test/session/loop-streak.test.ts` PASS (24). Independent review of `9bab2c2a12` found 3 criticals + 3 mediums → fixed `5a597d938e` → re-review PASS. Persisted-span follow-up after design critique that per-request re-detection breaks prefix stability. Follow-up review of `f246a05e0`: #1–#4 (re-apply suppressing text-loop, `crop.kept`, dead exports, key-range crop) confirmed and fixed in `e5c9ba229b`; #5 (`span.toId === lastFinished.id` "dead guard") rejected — empty-key lastFinished is not in `entries`, so the guard skips a new crop after the streak already broke. Second-pass review: #4's regression test used `x_between`, which sorts after `a3` and never reached the `streakKey` clause — patched to an in-range id (`a1narr`) and mirrored for `applyPersistedCrops`.

**Journey log** — Suffix delete does not break Anthropic 20-block lookback by itself; real risks are deleting the anchor, a long recovery body, or middle-of-prefix edits. Streak key must be thinking-primary. Per-request re-detection is wrong: if the tail changes, the view flips, LCP truncates, and poison returns — detect once, persist the span as an ignored part on the parent user, re-apply every request. Never invent a Continue. user; `transform.ts` owns trailing-assistant Continue.

## [S1] Problem

Agent turns enter repetitive streaks: the same (or near-identical) thinking is replayed across consecutive assistant messages while tools only drift slightly. Current detectors often miss this shape:

- `text-loop` keys on visible text + tool inputs; pure thinking+tool loops with changing narration never trip it, and its recovery only *appends* a reminder.
- `stepSignature` / repeated-step nudge keys only on tool name+input and also only injects a reminder.
- Recovery never removes the poisoned history, so the next turn still sees the failed plan as few-shot context (observed in session `ses_-ffe5fb84445ccffeZsPH2DWlj`, where "I got stuck in a loop…" and identical 4935-char thinking replayed for many consecutive assistants).

Local DB evidence (message/part tables):

| Signal | Streaks | Max consecutive |
|--------|---------|-----------------|
| Identical reasoning head | 621 | 661 |
| Identical tool signature | 3469 | 628 |
| Thinking streak ≥ 20 msgs | 12 | — |
| Tool streak ≥ 20 msgs | 15 | — |

So "delete more than 20 Anthropic content blocks" is a normal case, not an edge case. That does **not** by itself break Anthropic lookback: lookback walks *remaining* blocks from the new breakpoint, and a suffix delete keeps the pre-loop write anchor within 1–2 blocks. The real cache risks are deleting the anchor, inserting a long recovery body, or middle-of-prefix edits.

## [S2] Design

### Contracts

1. **Physical layer is audit-only.** Loop recovery never `removeMessage`s. DB keeps the full trajectory for replay, undo, and forensics.
2. **Request-layer crop, no new user.** Align with turn recovery (`resume`): do **not** create a Continue./recovery user. Reuse the existing parent user (`lastUser` unchanged → `parentID` matches resume). Persist the span as an `ignored` + `synthetic` text part on that user. Trailing-assistant repair stays in `transform.ts`.
3. **Thinking is always in scope.** Deletion unit is a whole assistant message (reasoning + text + tools + embedded results). No part-level surgery in v1.
4. **Anchor is mandatory.** The message immediately before the streak start is never removed (user or non-matching assistant).
5. **No snapshot rollback.** Dirty workspace after an edit streak is treated like an external file change; the model re-reads and re-plans.
6. **Effectiveness > cache.** Breaking the loop wins over a cache miss. Prefer prefix-safe crop; never keep poison thinking just to save cache.

### Streak signature

Per finished assistant message, build:

```text
reasonHash = sha256(normalize(join(all reasoning part texts)))
toolSig    = stableStringify(tools in part-id order)

key = "reason:" + reasonHash     when reasoning is present
key = "tool:"   + toolSig        when only tools are present
key = ""                         when neither is present
```

Thinking is the loop source: crop eligibility keys on thinking alone so
slightly drifted tools still form one streak (MR-3931 shape). Tool-signature
keys are the fallback for thinking-less steps. Normalize reasoning like
`normalizeForLoopDetection` before hash. Do **not** rewrite stored parts;
hash is offline-only.

### Detection

Detect **once** per streak, not on every request. Re-detecting would flip the
request view, break the cache prefix, and re-introduce poison thinking after a
successful crop.

At the start of each loop iteration:

1. Re-apply **every** persisted span (`extractAllCrops` / `applyPersistedCrops`) from user-part metadata (`kind: "loop_streak_crop"`). Spans stay active for the life of the feature — including after the user sends a new message — so poison thinking cannot re-enter the request view.
2. Then, only when `lastUser.id < lastFinished.id` (continuing from a model step), detect a **new** streak on the already-cropped view:
   - Build keys for finished assistants.
   - Trigger when the last `triggerCount` (default 3) finished assistants share one `key`.
   - Walk backward while `key` matches; predecessor is the **anchor** (always kept).
   - Require `span.toId === lastFinished.id`.
   - On hit: crop the request view, **persist** an `ignored` + `synthetic` text part on the **existing** `lastUser` whose `metadata.origin` is `{ kind: "loop_streak_crop", fromId, toId, key, truncated }`. Do not create a new user; do not reassign `lastUser`.
3. Clearing is explicit only: turn the feature off (next request returns to the full view). There is no auto-clear on user speech.

Persisting the span as an ignored part on the parent user gives: stable
prefix across later requests, restart survival, no new user/parentID, and no
model-facing loop wording. Cropped assistants stay in the DB.

### Request crop

```text
kept     = messages with id < span.from OR id > span.to
         + force-include anchor (id < span.from, already kept)
span     = ignored synthetic part on the existing parent user
```

Later requests re-apply the same `fromId..toId` filter. No extra user is
inserted. If the cropped view ends on an assistant, `transform.ts` trailing-
assistant repair supplies `Continue.` on the wire only.

Invariants (assert in tests, log in prod):

- Kept prefix JSON equals original messages with span filtered out (no reorder, no field rewrite).
- Parts inside kept messages stay in `part.id` order.
- Tool_use/tool_result pairing is preserved because whole assistants are removed.
- Conversation after crop + recovery ends with a user message (Bedrock prefill safety).

### Safety ceiling

| Knob | Default | Behavior |
|------|---------|----------|
| `max_span` | 64 | If streak length > ceiling, crop only the **trailing** ceiling messages of the streak (most recent poison). Older same-key messages stay; recovery note states remaining similar count. |
| `trigger_count` | 3 | Same as current text-loop trigger. |
| `enabled` | false (experimental) | Behind `experimental.loop_streak_recovery`. |

Ceiling exists only to stop a detector bug from nuking a multi-hour 600-message run. It is not a cache bound.

### Cache audit (not a gate)

On every crop, emit slog:

```text
session_id, spanFrom, spanTo, anchorId,
nMessages, nParts, omittedBlocks, keptBlocks,
remainingSimilar, truncatedByCeiling,
cacheRisk: omittedBlocks > 20
```

`omittedBlocks` ≈ per cropped message: `#reasoning + #text + 2×#tool`.
Rough is fine; purpose is observability of "we routinely crop >20 blocks".

**Do not skip crop when `cacheRisk` is true.** Log only.

### Provider notes

| Provider | Crop impact |
|----------|-------------|
| Anthropic | Suffix delete keeps pre-loop write; lookback hits anchor. Immediate next request maximizes hit. Thinking signatures disappear with the deleted assistants (desired). |
| OpenAI | LCP ends at anchor; usually hit, best-effort. |
| DeepSeek `interleaved.field` | Whole-assistant delete is the only safe mode; join cannot align thinking to tools. v1 already whole-assistant only. |
| Bedrock | No new user is inserted; if the cropped view ends on an assistant, `transform.ts` trailing-assistant repair supplies `Continue.` on the wire. |
| MiMo self-hosted | Behavior win only; no cache contract. |

### Interaction with existing detectors

- **text-loop / text-ngram**: keep as fallback when streak key does not fire (e.g. pure text loops with no tools/reasoning). If streak crop already ran for this turn, skip injecting another recovery user (`loopStreakCropped`).
- **repeated-step nudge**: keep; it fires on identical tools even when thinking differs. Streak crop keys on thinking when present, so both can independently surface related loops.
- **try-best / doom_loop**: unchanged (pause / permission). Independent of crop.

### Recovery note content

None in the model-facing stream. Span persistence uses an `ignored` +
`synthetic` part (text body irrelevant; not sent). No loop/recovery wording.
Counts/audit stay in slog. Wire-level trailing assistant uses `transform.ts`
`Continue.` only.

## [S3] Out of Scope

- Physical deletion / compaction of loop spans.
- Snapshot or filesystem rollback of edit streaks.
- Part-level tail surgery inside one assistant (interleaved R-T-R).
- Changing Anthropic breakpoint placement in `transform.ts`.
- Unifying try-best pause UX with streak crop.
- Cross-message "similar but not identical" clustering (fuzzy streak beyond exact key match).

## Tasks

- [x] T1: Streak signature module — acceptance: pure functions compute `reasonHash`/`toolSig`/`key` from parts; unit tests cover empty reasoning, empty tools, order stability, normalize. (covers: S2)
- [x] T2: Streak detector — acceptance: given a sequence of assistant keys, reports trigger, span `[from,to]`, anchor predecessor; respects trigger_count and ceiling trailing-crop. (covers: S2; depends: T1)
- [x] T3: Request cropper — acceptance: filters a message list by span without reorder/rewrite; creates no new user; invariants hold on fixture with parallel tools. (covers: S2; depends: T2)
- [x] T4: prompt.ts integration — acceptance: after a finished step, experimental flag on, a 3× identical-thinking streak crops the next request and logs audit fields; flag off path unchanged. (covers: S2; depends: T3)
- [x] T5: Regression tests — acceptance: MR-3931-shaped fixture (identical thinking, drifting tools) is cropped; pure tool-loop and pure text-loop still behave as before when keys differ; no crop when span would include the anchor. (covers: S2; depends: T4)
- [x] T6: Align with turn recovery — acceptance: crop creates no new user; span persists as ignored synthetic part on the existing lastUser; lastUser/parentID unchanged; tests cover ignored-part extract + no-new-user. (covers: S2)
