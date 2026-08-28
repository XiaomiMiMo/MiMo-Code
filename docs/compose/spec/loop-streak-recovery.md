---
feature: loop-streak-recovery
status: designed
updated: 2026-08-28
branch: feat/loop-streak-recovery
commits: 
---

# Loop Streak Recovery

## Report

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
2. **Request-layer crop.** When a streak is detected, the next request omits the streak's assistant messages and ends with one short synthetic user recovery note.
3. **Thinking is always in scope.** Deletion unit is a whole assistant message (reasoning + text + tools + embedded results). No part-level surgery in v1.
4. **Anchor is mandatory.** The message immediately before the streak start is never removed (user or non-matching assistant).
5. **No snapshot rollback.** Dirty workspace after an edit streak is treated like an external file change; the model re-reads and re-plans.
6. **Effectiveness > cache.** Breaking the loop wins over a cache miss. Prefer prefix-safe crop; never keep poison thinking just to save cache.

### Streak signature

Per finished assistant message, build:

```text
reasonHash = sha256(normalize(join(all reasoning part texts)))
toolSig    = stableStringify(tools in part-id order)   // name + input, existing stepSignature style
key        = reasonHash + "\0" + toolSig
```

- Empty `toolSig` → key is `reasonHash` only (thinking-only loop).
- Empty `reasonHash` → key is `toolSig` only (legacy shape).
- Normalize reasoning like `normalizeForLoopDetection` (trim, lowercase, collapse whitespace) before hash. Do **not** rewrite stored parts; hash is offline-only.

### Detection

After a step finishes (same site as today's text-loop check in `prompt.ts`):

1. Push `key` onto a streak buffer (reuse `TEXT_LOOP_BUFFER_SIZE` semantics).
2. Trigger when the last `triggerCount` (default 3) finished assistants share one `key`.
3. Walk backward from the current message while `key` matches; stop at the first non-match. That predecessor is the **anchor** (always kept).
4. Span = `[firstMatching, current]` inclusive.

### Request crop

```text
kept     = messages with id < span.from OR id > span.to
         + force-include anchor (id < span.from, already kept)
recovery = one synthetic user text part, appended as a new user message
```

Invariants (assert in tests, log in prod):

- Kept prefix JSON equals original messages with span filtered out (no reorder, no field rewrite).
- Parts inside kept messages stay in `part.id` order.
- Tool_use/tool_result pairing is preserved because whole assistants are removed.
- Conversation after crop + recovery ends with a user message (Bedrock prefill safety).

### Safety ceiling

| Knob | Default | Behavior |
|------|---------|----------|
| `max_span_messages` | 64 | If streak length > ceiling, crop only the **trailing** ceiling messages of the streak (most recent poison). Older same-key messages stay; recovery note states `omitted_trailing=N, remaining_similar=M`. |
| `trigger_count` | 3 | Same as current text-loop trigger. |
| `enabled` | false (experimental) | Behind `experimental.loop_streak_recovery`. |

Ceiling exists only to stop a detector bug from nuking a multi-hour 600-message run. It is not a cache bound.

### Cache audit (not a gate)

On every crop, emit slog + optional bus/metrics event:

```text
session_id, span_from, span_to,
n_messages, n_parts, est_blocks,
anchor_id, truncated_by_ceiling,
cache_risk: est_blocks > 20
```

`est_blocks` ≈ per message: `#reasoning + #text + #tool` (assistant side) plus `#tool` (wire tool_result side). Rough is fine; purpose is observability of "we routinely crop >20 blocks".

**Do not skip crop when `cache_risk` is true.** Log only.

### Provider notes

| Provider | Crop impact |
|----------|-------------|
| Anthropic | Suffix delete keeps pre-loop write; lookback hits anchor. Immediate next request maximizes hit. Thinking signatures disappear with the deleted assistants (desired). |
| OpenAI | LCP ends at anchor; usually hit, best-effort. |
| DeepSeek `interleaved.field` | Whole-assistant delete is the only safe mode; join cannot align thinking to tools. v1 already whole-assistant only. |
| Bedrock | Recovery user keeps trailing-user invariant. |
| MiMo self-hosted | Behavior win only; no cache contract. |

### Interaction with existing detectors

- **text-loop / text-ngram**: keep as fallback when streak key does not fire (e.g. pure text loops with no tools/reasoning). If streak crop already ran for this turn, skip injecting another recovery user.
- **repeated-step nudge**: keep; it fires on identical tools even when thinking differs slightly. Streak key is stricter (thinking must match too) for crop eligibility.
- **try-best / doom_loop**: unchanged (pause / permission). Independent of crop.

### Recovery note content

Short, synthetic, one user message. Must include: loop detected, N steps omitted from context, abandon current approach, do not replay the same thinking. No long essays (long recovery is a real 20-block risk).

## [S3] Out of Scope

- Physical deletion / compaction of loop spans.
- Snapshot or filesystem rollback of edit streaks.
- Part-level tail surgery inside one assistant (interleaved R-T-R).
- Changing Anthropic breakpoint placement in `transform.ts`.
- Unifying try-best pause UX with streak crop.
- Cross-message "similar but not identical" clustering (fuzzy streak beyond exact key match).

## Tasks

- [ ] T1: Streak signature module — acceptance: pure functions compute `reasonHash`/`toolSig`/`key` from parts; unit tests cover empty reasoning, empty tools, order stability, normalize. (covers: S2)
- [ ] T2: Streak detector — acceptance: given a sequence of assistant keys, reports trigger, span `[from,to]`, anchor predecessor; respects trigger_count and ceiling trailing-crop. (covers: S2; depends: T1)
- [ ] T3: Request cropper — acceptance: filters a message list by span without reorder/rewrite; appends exactly one recovery user; invariants hold on fixture with parallel tools. (covers: S2; depends: T2)
- [ ] T4: prompt.ts integration — acceptance: after a finished step, experimental flag on, a 3× identical-thinking streak crops the next request and logs audit fields; flag off path unchanged. (covers: S2; depends: T3)
- [ ] T5: Regression tests — acceptance: MR-3931-shaped fixture (identical thinking, drifting tools) is cropped; pure tool-loop and pure text-loop still behave as before when keys differ; no crop when span would include the anchor. (covers: S2; depends: T4)
