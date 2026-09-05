# MiMo Loop Detection

**One-line summary**: two detectors plus one handler. Chain-of-thought repetition is caught by large-window, large-N n-gram detection; repeated tool calls are caught by consecutive-identical and periodic-call detection with no progress check; handling reuses the existing three-tier escalation in the code (remind → replan → terminate). No extra model; everything runs in the agent runtime (`packages/opencode/src/session/`).

All numbers below are starting points and must be calibrated on real trajectories.

## 1. Chain-of-thought repetition detection

Only inspect the reasoning and text generated in the current step. Never mix in user input or tool output. If the provider only exposes a thinking summary, only the summary can be checked.

### Parameters

| Item | Value |
| --- | --- |
| Sliding window | last 8192 detector tokens (output of `tokenizeForNgram`: whitespace-split words, CJK per character) |
| n-gram length | 64 |
| Trigger | the same n-gram occurs ≥ 3 times, counted at non-overlapping positions |
| Cadence | check every 256 new tokens; on hit, abort the current generation and return `text-repeat` |

### Implementation

Reuse the streaming hook of `TextNgramMonitor` (`checkTextNgram` in `processor.ts`, and `max-mode.ts`). Swap the inner detector from `detectConsecutiveRepeat` to the already-written `detectRepeatedNgram(tokens, 64, 3)` and raise the window from 500 to 8192. Replace `slice().join()` with a rolling hash so each token costs O(1).

Flags: `MIMOCODE_TEXT_NGRAM_N=64`, `MIMOCODE_TEXT_REPEAT_THRESHOLD=3`, `MIMOCODE_TEXT_WINDOW_TOKENS=8192`.

### Out of scope

No MinHash/Jaccard, no coverage ratio, no code-block exclusion. Paraphrased repetition is allowed to go undetected for now.

## 2. Repeated tool call detection

Keep the signatures of the last 12 completed tool calls. Signature = tool name + arguments (JSON keys sorted, reuse `stableStringify`). Do not collapse whitespace inside strings and do not drop arguments. Arguments are part of the comparison: reading three different files in a row is not a repeat.

| Type | Condition |
| --- | --- |
| Consecutive identical calls | the last 3 signatures are identical. Matches the existing `REPEATED_STEP_THRESHOLD=3` |
| Periodic calls | the signature sequence has a period p ∈ [2, 4] and the last 3p calls match position by position. Example: read A → grep B → read A → grep B → read A → grep B |

On a hit, do not check whether files or test results changed. Go straight to the handling in section 3.

### Polling and retry exceptions (relaxed thresholds, still logged)

- Bash commands matching `sleep`, `wait`, `watch`, `poll`, `status`, `tail -f`, or tools that are inherently wait/monitor tools: allow 10 occurrences of the same signature or 10 minutes total, then treat as consecutive identical calls.
- Previous result was a transient network error (`ETIMEDOUT`, `ECONNRESET`, HTTP 5xx / 429): allow 3 backoff retries that do not count toward repetition.

## 3. Handling: three-tier escalation

Reuse the existing mechanism (`RECOVERY_PROMPT_MILD/STRONG`, `TEXT_NGRAM_RECOVERY_REMIND/REPLAN`). Both detectors share one counter, capped at 2 recoveries per user turn.

| Hit # | Action | Injected content |
| --- | --- | --- |
| 1st | Remind | Abort the current generation or hold the next call; add a synthetic user message stating what repeated (n-gram fragment / tool signature and count) and asking for different wording or a different action |
| 2nd | Replan | Require abandoning the current approach, writing a new plan, and stating what was attempted, why it failed, and how the new plan differs |
| 3rd | Terminate | Publish `Session.Event.Error`, keep existing edits, report the looping actions, recoveries attempted, and the current blocker |

On a chain-of-thought hit, mark the current assistant step as error so `toModelMessages` skips it and the repeated tail never flows back into the next request. On a tool-repeat hit, never auto-replay and never auto-revert code.

## 4. Integration and logging

- **In the generation stream**: n-gram detection runs incrementally; without a stream, check the whole output after generation ends.
- **After a step completes, before the next decision**: update the tool signature window and run the consecutive/periodic checks. This is where the existing "repeated-step nudge" lives; route the nudge through the three-tier escalation and count it.

Log `loop_detected` (type, signature or fragment, count), `recovery_attempted` (tier), and `loop_terminated`. Start with `MIMOCODE_LOOP_MODE=monitor` (log only), review hit trajectories by hand, then switch to `enforce`.

> Do not replace this with decode-time `no_repeat_ngram_size`. It blocks code, paths, and other content that must legitimately repeat, and is a different thing from runtime loop detection.
