---
feature: degenerate-generation-guard
status: proposed
updated: 2026-10-03
---

# Degenerate Generation Guard

## [S1] Problem

The session loop already carries three repetition governors — `text-loop-recovery`
(identical normalized steps), `text-ngram-detection` (repeated token blocks), and
`loop-streak` (thinking/tool-signature streaks) — but two runaway shapes observed
in field sessions escape all three:

1. **No-op tool narration runs.** The model announces a tool call in prose ("use
   Read now", "final", "grading") and then emits bare `echo`/`printf` bash calls
   instead of the announced call. One observed session emitted 20+ consecutive
   literal echoes and never issued the real call. Every detector stayed silent:
   each echo exits 0 (no failure signal), the strings differ every time (signature
   and normalized-text keys never match), and the degeneration lives in the tool
   channel, which the text governors do not scan. This is intent-action
   decoupling ("description as execution"), not byte-level repetition.

2. **Intra-stream text degeneration.** Three sub-shapes inside one stream, none
   of them token-block repeats: (a) an identical line-group cycling at a
   data-derived period (e.g. a 3-line block streamed 3×; a single line echoed 4×),
   (b) bare tokens stepping +1 (integers `1,2,…,179`; bijective base-26 letters
   `a,b,…,kf`) — every n-gram of a counting stream is distinct, so n-gram
   detection never fires, (c) no-newline streaming of one string (a ≥32-char
   phrase repeated back-to-back), which tokenizes into one giant token.

Measured against the existing governors:

| Shape | text-loop | text-ngram | loop-streak | here |
|---|---|---|---|---|
| identical steps / repeated token blocks | covered | covered | covered | — |
| varying-string echo narration runs | miss | miss | miss (keys exact tool input) | `findNoopBashRun` |
| line-group cycle at derived period | miss | partial (needs ≥3 distinct tokens/block) | miss | `findTextDegeneration` |
| bare-token +1 sequences | miss | miss (all n-grams distinct) | miss | `findTextDegeneration` |
| no-newline char-period stream | miss | miss (one token) | miss | `findTextDegeneration` |

Detection logic and thresholds are ported from a battle-tested degeneration
watchdog built against MiMo-family model sessions (2026-09 incident class) and
adapted to this codebase's recovery pipeline.

## [S2] Design

### Contracts

1. **Pure detectors, recovery via the existing pipeline.** Detectors return a
   `DegenerateFinding`; recovery reuses the synthetic-user-turn reminder path
   (`handleTextRepeat` pattern), per-channel budgets, and the
   max-recovery → terminate semantics. No provider-layer changes.
2. **Two channels, independent budgets.** `text` (stream shapes) and `tool`
   (no-op bash runs) each get `MIMOCODE_DEGENERATE_MAX_RECOVERY` attempts (default
   2) so one channel cannot starve the other.
3. **Conservative by construction.** A missed no-op is acceptable; a false
   positive is not. Anything with shell structure (metacharacter, pipe, redirect,
   expansion, chaining, newline) classifies as a real command and resets the run.
4. **Recovery names the pattern.** The injected `<system-reminder>` quotes the
   finding (`kind` + `pattern`) so the model knows what specifically to stop.

### Detectors (`packages/cli/src/session/prompt/degenerate-generation.ts`)

**Text channel — `findTextDegeneration(text)`:** bounded tail scan (96 KB) over
the streamed text (reasoning + text deltas).

- (a) *Line-group suffix repeat:* the last 4p lines are one line-group repeated
  ×4, period `p` derived from the data (`p ≤ 640`) — a uniform ≥4-copy bar
  (`MIMOCODE_DEGENERATE_MIN_COPIES`). Identical 2–3-line codegen blocks at ×3
  (repeated JSX cards, config/SQL stanzas) are legitimate output and stay clean;
  a stuck block streams far past four copies. A single repeated line additionally
  needs real letter/digit content — separator/log lines stay clean. Groups under
  16 chars do not trigger.
- (b) *Bare-token +1 sequences:* ≥12 trailing bare tokens stepping +1 — integers
  (`^-?\d{1,10}$`) or bijective base-26 letters (`^[a-z]{1,3}$`). Numbered list
  items (`1. step`) are not bare tokens and stay clean.
- (c) *No-newline char period:* on line-sparse tails, the same ≥32-char string
  (with a letter/digit) repeated ≥4× at a char-level suffix period, and only
  when the repeated unit is prose-shaped (≥3 whitespace-separated words) —
  minified codegen (CSS/SQL/JSON one-liners) is line-sparse by nature and is
  deliberately excluded. Short-period streams (`"very very…"` period 5) are
  caught at their ≥32-char super-period.

**Tool channel — `findNoopBashRun(tools)`:** a trailing run of ≥4 distinct no-op
bash calls (`MIMOCODE_DEGENERATE_TOOL_RUN_MIN`). `isNoopBashCommand` classifies
literal `echo`/`printf`/`true`/`:` with no side effects (quotes stripped,
word-boundary `#` comments dropped, `/bin/echo` normalized, trailing lone `;`
tolerated); everything else is real. Re-observations of one call (same `pid`)
count once; an unknown command is skipped without breaking the run; a truncated
recorded command breaks it (truncation can forge a literal). Non-bash tool calls
reset the run.

### Wiring

- **Text:** a `DegenerateGenerationMonitor` rides next to the ngram monitor in
  `session/processor.ts`. On a hit the stream is cut (same `takeUntil` seam) and
  `process()` returns `{ degenerate: finding }`; `session/prompt.ts` injects the
  reminder via `handleDegenerate` (budget per channel; exhaustion publishes an
  error and stops, mirroring `handleTextRepeat`). Max-mode propose-only
  candidates get the same guard at the source (`runCandidate` fails with a
  degenerate signal the way the ngram monitor fails with `textNgramRepeat`, and
  `runMaxStep` propagates the finding).
- **Tool:** a cross-step `noopBashBuffer` beside `textLoopBuffer` in
  `session/prompt.ts`, fed from completed tool parts after each step (non-bash
  calls enter the buffer so they reset the run). On a hit the
  `NOOP_BASH` reminder is injected the same way.
- **Compaction:** a degenerate finding during compaction rolls the attempt back
  (same path as `text-repeat`).

### Knobs

| Env | Default | Meaning |
|---|---|---|
| `MIMOCODE_DEGENERATE_TOOL_RUN_MIN` | 4 | trailing no-op bash calls before a finding |
| `MIMOCODE_DEGENERATE_SEQ_MIN` | 12 | bare tokens in a +1 sequence before a finding |
| `MIMOCODE_DEGENERATE_MIN_COPIES` | 4 | identical copies before a repeat finding (line-group or char-period) |
| `MIMOCODE_DEGENERATE_MAX_RECOVERY` | 2 | recovery turns per channel before terminating |

### Optional enhancement (not in this change)

An earlier field-tested variant interrupts mid-episode instead of waiting for the
step boundary (`session.abort` + corrective prompt on v1-style hosts;
`session.interrupt({ continue:false })` + prompt on v2-style hosts) and arms one
intervention per degeneration episode (re-arms only after clean output), with
budget counted per session per channel and `VIBEWEAVER_LOOPGUARD=off` as an
all-stop. The detectors here are compatible with that recovery style; adopting
it is a separate, behavior-heavier decision.

### Known gaps (honest boundaries)

- Semantic no-ops that are not literal echo/printf (`sleep 1`, `ls`, `pwd`,
  `date` floods) and echo/read oscillation are not detected — they need
  intent-action consistency analysis, not syntax classification.
- Decorated narration (`echo x > /dev/null`, `echo x && true`) classifies as
  real by design (conservative bias).
- `true ;` (space before `;`) classifies as real — a safe-direction miss.
- A repeated unit without word structure (a single long identifier or minified
  rule streamed back-to-back) stays clean under the prose bar — the bar trades
  that class away to keep minified codegen unguarded-false-positive-free.
- Line groups cycling at periods >640 lines and char periods >1024 fall outside
  the bounded scan windows.
- The replay path (`processor.replay`, max-mode winner serialization) carries no
  text governor — pre-existing parity with the ngram monitor; candidate streams
  are covered at the source instead.
- The `pid`/`truncated` protections of `findNoopBashRun` engage only for hosts
  that feed them; the prompt.ts tool feed passes one observation per completed
  tool part and does not populate them.
