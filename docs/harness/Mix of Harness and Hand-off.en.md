# Mix of Harness && Hand-off

**In one line**: package **Codex CLI** and **Claude Code CLI** as callable executors exposed through skills, so that when MiMoCode falls into a "low-yield loop," it can pause the current turn and let the user hand the work to another harness with one action. The control plane remains in the MiMoCode session, while the execution plane runs in the selected harness—the two planes are decoupled.

Supported harnesses: **Codex CLI** && **Claude Code CLI**.

---

## 1. Why Mix of Harness

When a single harness encounters a task it is inherently poor at, it almost never recovers on its own: Codex is more optimistic and tends to declare completion too early; Claude Code explores in greater detail, but under explicit instructions it can get stuck repeatedly rewriting similar diffs. The real failure signal is not that "one step failed," but that **spending more tokens still produces no progress**—the same file is edited repeatedly, the same bash command is retried unchanged, or the ratio of exploration to modification does not improve.

Mix of Harness (MoH below) addresses this problem by turning each harness into an executor that MiMoCode can launch through a skill and run as a subprocess. A **Try-Best detector** monitors the health of the current turn; once it detects a low-yield loop, it pauses the turn and lets the user choose a more suitable harness to take over.

**Core boundary**: MoH **does not switch the session's provider/model**. After selecting "hand off to Codex CLI" or "hand off to Claude Code CLI," the session remains the original MiMoCode session with the original model. The model is simply instructed to load the corresponding skill and delegate execution to the selected harness. Context, task panels, memory, and approval routing therefore do not need to be rebuilt.

---

## 2. SKILL Design

Codex and Claude Code are each packaged as a **built-in skill**, located at `<data>/builtin_skills/local/skills/codex/` and `<data>/builtin_skills/local/skills/claude-code/`, respectively. Each skill directory contains:

```
codex/
  SKILL.md                # Trigger description + operating rules (prefer headless; no interaction except --yolo)
  agents/openai.yaml
  references/
    recipes.md            # Common codex exec patterns
    windows.md            # Separate guidance for native PowerShell and WSL2

claude-code/
  SKILL.md
  references/
    config.md
    flags.md
    interactive-tmux.md
    platforms.md
    print-mode.md
```

SKILL.md is the entry point, and its `description` field determines when the skill router triggers it. The principle is to **provide directly executable CLI command templates in the skill**. For example, the Codex skill immediately provides:

```bash
codex exec \
  -C /path/to/repo \
  --sandbox workspace-write \
  --ask-for-approval never \
  "<TASK>"
```

rather than making the model look up a combination of flags itself. Cross-platform differences (macOS/Linux vs. Windows PowerShell vs. WSL2) are covered by the documents under `references/`.

> **Why use a separate skill instead of a built-in tool?** Harness operating details stay in the skill and are injected together with the model prompt; the tool layer exposes only the ability to run a subprocess. Skill updates, cross-platform differences, and flag changes can all be handled by replacing the skill directory without changing code.

---

## 3. The Five MoH Modes

Different tasks need different orchestration structures. MoH currently supports the following five modes. **Fallback is MiMoCode's default mode**—the path that automatically enables Try-Best detection and Hand-off.

### 3.1 Single

```
Task → Codex → Validator
```

Run a single harness directly, followed by a validator. Suitable when a harness is fully trusted and the task scope is clear.

### 3.2 Fallback (default)

```
Task → MiMoCode
          │ failure/stall
          ▼
        Codex / Claude Code
```

MiMoCode first attempts the work itself. After a failure or stall signal is detected, the user chooses another harness to take over. Common rules for detecting failure/stall include:

- N consecutive failures from the same class of tool
- No file changes for more than X minutes
- Too many context compactions
- No improvement across consecutive test results
- Cost exceeding 80% of the budget
- Final output missing a required artifact

The Try-Best detector (see §4) implements the subset of these rules that can be evaluated in real time within a turn.

### 3.3 Pipeline

```
Claude Code research
       ↓ HandoffPacket
Codex implementation
       ↓ Patch
MiMoCode review
       ↓ Findings
Codex repair
```

Stages are connected in sequence, with the best harness used for each stage and structured packets carrying context between adjacent stages. Suitable for tasks with clear stage boundaries (understand before changing, review after implementation).

### 3.4 Parallel Competition

```
               ┌→ Claude Code → Patch A ┐
Task → Fork ───┤                        ├→ Evaluator
               └→ Codex        → Patch B ┘
```

Multiple harnesses independently perform the same task, and an evaluator chooses the result to adopt. Suitable when boundaries are unclear, several approaches are plausible, and taking a probabilistic bet is worthwhile. **It costs more**, so it is not the default.

### 3.5 Debate / Review

```
Codex Implementer → Claude Reviewer → Codex Repairer
```

One harness proposes an implementation, another challenges it, and the first harness then repairs it. Suitable for correctness- or security-sensitive changes that need cross-checking.

---

## 4. Hand-off Mechanism (Try-Best HandOff)

Try-Best HandOff automates Fallback mode: it **monitors low-yield loops in real time within a turn** and, upon a match, pauses the turn, records evidence from the scene, and gives the user the choice of what to do next.

### 4.1 What Counts as a "Low-Yield Loop"

The failure modes of coding agents leave observable shapes in their trajectories. Try-Best selects the strongest signals:

- **Loops and repetition**. The same file is edited repeatedly (edit count exceeds a threshold), semantically similar diffs appear consecutively, or the same bash command is retried unchanged after repeated failures. This is the strongest precursor to failure—once an agent enters a loop, it almost never escapes on its own, and spending more tokens is pure waste. In practice, **sliding-window deduplication** over the most recent N tool calls is sufficient; embeddings are unnecessary.
- **Progress decoupled from consumption**. Define a coarse progress signal (change in passing-test count, or the proportion of files mentioned by the issue covered by the diff) and compare it with token burn rate. If 40% of the budget is spent with zero progress, the harness is almost certainly unsuitable for the task; switching is much cheaper than waiting for it to finish.
- **Lost-navigation pattern**. Reading files during exploration is normal, but broad greps late in the task, repeatedly reading the same large files, or opening directories unrelated to the issue indicate that the agent has not built a working model of the repo. Quantify this with the ratio of new-information operations to modification operations over the last K steps—a healthy trajectory should show a monotonically decreasing ratio over time.
- **Premature completion claims**. The harness says it is done, but the trajectory contains no test run, or it ran tests without inspecting the result. **Do not trust self-reported completion**; Codex is more optimistic about this than Claude Code.

### 4.2 Detection Mechanism (Three Trigger Reasons)

The current implementation in `packages/opencode/src/session/try-best-detector.ts` detects the first two signal classes through three concrete rules:

| Reason | Description | Default threshold |
|---|---|---|
| `edit_repeat` | Approximate edits to the **same file**: extract each diff into a set of 3-shingles, then compare the latest 12 edit events using **Jaccard similarity**; similarity > 0.8 counts as one match | Trigger after ≥ 2 cumulative matches (that is, on the "third approximate edit") |
| `bash_retry` | A normalized bash command **fails consecutively** with unchanged failure output | 3 consecutive times |
| `action_streak` | Consecutive actions of the same class (`edit` or `verify`) show no observable improvement | 4 consecutive times |

Commands and results are normalized to prevent false positives caused by timestamps, temporary paths, or random seeds:

- Command: `/tmp/...` → `<TMP>`, pure numbers of 6 or more digits → `<NUM>`, `--seed=xxx` → `<SEED>`
- Result: durations such as `Ns / Nms / N seconds` are additionally removed; results longer than 2,000 characters retain half from each end with `<TRUNCATED>` inserted in the middle

`verify` commands (bun/npm/pnpm/yarn test/typecheck/lint/build, pytest, cargo test, go test, make test, tsc, etc.) participate in `bash_retry` detection and also count toward `action_streak`.

### 4.3 Pausing and Persistence

After any reason is triggered, `SessionProcessor.detectTryBest`:

1. **Resets the monitor** to avoid repeated triggers within the same turn.
2. **Sets `ctx.blocked = true`** so that the processor returns `stop` for subsequent model output and the prompt loop immediately exits the current turn.
3. **Writes a synthetic `TextPart`**: `text` contains a human-readable reason ("Try-best loop detected; this turn was paused. …"), while `metadata.origin` contains `kind: "try_best"`, the current `providerID / modelID`, and the complete `incident` (reason + evidence). **The part is the source of truth**: even if an event subscriber disconnects, a restarted session can recover by scanning parts.
4. **Publishes a `session.try_best.detected` event**: the TUI subscribes to it and immediately opens a dialog. The event is a low-latency notification, while the part provides the fallback.
5. **Publishes the metrics event** `Metrics.TryBestDetected`, making it possible to track trigger frequency by model/reason.

### 4.4 User Choice (Three Options in the TUI Dialog)

After pausing, the TUI opens a dialog titled "Try-best loop detected — turn paused." Its description includes specific evidence (for example, "Near-identical edits repeated 3 times in packages/opencode/src/foo.ts"). It offers three options:

1. **Continue with Codex CLI** (`Hand off to Codex CLI`)
2. **Continue with Claude Code CLI** (`Hand off to Claude Code CLI`)
3. **Keep the current model but continue with a different strategy** (`Continue with <model>`)—make the original model abandon its current approach and re-plan

Candidate targets **exclude the current model family** (`handoffTargets` in `packages/opencode/src/cli/cmd/tui/util/handoff.ts`):

- If the current provider is `openai`, or the model name contains `gpt / codex` → show only "Claude Code CLI" (no second attempt with itself)
- If the model name contains `anthropic / claude` → show only "Codex CLI"
- Otherwise → show both

The TUI also checks whether the corresponding skill (`codex` / `claude-code`) is registered in `sync.data.command`; an unregistered option is disabled.

### 4.5 Execution Protocol (Orchestrated Hand-off)

After a harness is selected, the TUI **does not switch sessions or models**. Instead, it sends `promptAsync` to the original sessionID, using a `<system-reminder>` as the next turn's input (see `formatHarnessReminder` for the template):

```
<system-reminder>
Try-best loop detection paused the previous turn: <detail>
The user explicitly selected and authorized the <harness> harness to take over the unfinished work.
You MUST load and follow the `<skill>` skill now and invoke <harness> as the primary executor …
Give the selected harness the complete user goal, relevant workspace state, the failed approach, and all remaining validation requirements. Do not include credentials, secrets, or unrelated private data.
Stay in this CLI and supervise <harness> until it completes or reaches a concrete blocker …
Inspect the harness result and workspace changes, ensure its validation is complete, and report the final outcome to the user. Do not stop after merely launching the harness.
</system-reminder>
```

Key points:

- **Control plane = original session**: the task panel, approval routing, context, and memory remain in the MiMoCode session; the harness is only a launched subprocess.
- **Execution plane = selected harness**: the actual research, implementation, repair, and validation must all happen in this subprocess. The system reminder explicitly forbids using the harness "only as a reference" or returning immediately after launching it.
- **The original model remains present**: it loads the skill, packages the work for the harness, supervises it to completion, and reports the final result to the user. It does not surrender control; it becomes the harness's runtime supervisor.

Selecting "keep the current model but use a different strategy" sends no reminder; it only clears `ctx.blocked`, allowing the original model to re-plan on the next turn.

---

## 5. Configuration

### 5.1 Master Switch

- **Environment variable `MIMOCODE_ENABLE_TRY_BEST_HANDOFF`** (default: `true`)
  - Set to `false` or `0` → disable the entire loop detection, turn pausing, and hand-off dialog capability.
  - Defined in `packages/opencode/src/flag/flag.ts`.

### 5.2 Thresholds (`experimental.try_best`)

Detection thresholds can be overridden individually in `mimocode.json` / config:

```json
{
  "experimental": {
    "try_best": {
      "edit_window": 12,
      "edit_similarity": 0.8,
      "edit_matches": 2,
      "action_streak": 4
    }
  }
}
```

Meaning:

| Key | Default | Description |
|---|---|---|
| `edit_window` | 12 | Number of most recent edit events included in comparison |
| `edit_similarity` | 0.8 | Jaccard similarity threshold (0–1); exceeding it counts as one match |
| `edit_matches` | 2 | Number of cumulative similarity matches needed before triggering (that is, trigger on edit N+1) |
| `action_streak` | 4 | Number of consecutive `edit`/`verify` actions without progress |

The consecutive failure count for `bash_retry` is currently fixed at 3 (`TRY_BEST_BASH_RETRIES`) and has no config option.

### 5.3 Skill Registration Status

The two harness options in the Hand-off dialog require the `codex` and `claude-code` skills to be registered in `sync.data.command`. An unregistered option is hidden so that users cannot select a harness that cannot be launched.
