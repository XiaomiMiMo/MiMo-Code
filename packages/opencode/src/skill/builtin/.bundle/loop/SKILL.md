---
name: loop
description: Schedule a prompt to fire on a fixed cadence (recurring loop). Use when the user asks to "run X every N minutes/hours/days", "loop X", "babysit Y", "be proactive about Y every N", or invokes `/loop` directly. Parses `[interval] <prompt>`, picks a clean cron expression, registers the job via the `cron` tool, and executes the prompt once immediately so the user sees activity without waiting for the first cron tick.
---

# /loop — schedule a recurring prompt

This skill turns a free-form `[interval] <prompt>` line into a `cron` tool call and runs the prompt once right away.

## 1. Parse the input

The user's text is whatever appears after `/loop `. Apply the three rules below **in order** and stop at the first match.

1. **Leading interval token.** If the first whitespace-separated token matches the regex `^\d+[smhd]$` (case-insensitive), that token is the interval. Examples: `5m`, `2h`, `1d`, `30s`. The rest of the input is the prompt.

2. **Trailing `every <N><unit>` clause.** Otherwise, look for a clause at the end of the input of the form `every <N><unit>` or `every <N> <unit-word>` where `<unit>` is `s|m|h|d` and `<unit-word>` is `second(s)|minute(s)|hour(s)|day(s)`. Strip the clause; what's left is the prompt; the captured `<N><unit>` is the interval. Examples: `every 20m`, `every 5 minutes`, `every 2 hours`.

3. **Default.** No interval found → interval is `10m`, the whole input is the prompt.

If the input is empty, or is *only* an interval with no prompt body, reply with a one-line usage hint (`/loop [interval] <prompt>`) and stop. Do not schedule anything.

## 2. Special: empty prompt with autonomous opt-in

When the user types `/loop <interval>` (interval only) **and** the project has explicitly opted into autonomous-loop mode (a session-level flag the runtime sets), the prompt body is the sentinel `<<autonomous-loop>>`. The scheduler expands this sentinel at fire time into a self-directed tick instruction. If autonomous mode is not enabled, treat empty as the usage-hint case above.

## 3. Map interval → 5-field cron expression

| Pattern | Cron expression |
|---|---|
| `Ns` | treat as `ceil(N/60)m`; minimum is `1m` |
| `Nm` where `N` is 1–59 and divides cleanly (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30) | `*/N * * * *` |
| `Nm` where `N ≥ 60` and `N/60` divides 24 (1, 2, 3, 4, 6, 8, 12) | `0 */(N/60) * * *` |
| `Nh` where `N` is 1–23 and divides 24 | `0 */N * * *` |
| `Nd` where `N` divides 31 sensibly (1, 2) | `0 0 */N * *` |

**Rounding rule.** If `N` does not divide its wrap-around cleanly (e.g. `7m`, `90m`, `5h`, `7d`), pick the **nearest interval that does** and tell the user explicitly what you rounded to and why. Acceptable nearby values:

- minutes < 60: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30
- hours: 1, 2, 3, 4, 6, 8, 12
- days: 1, 2

Examples of rounding messages:
- `7m` → "rounding 7m to 6m so the fires stay evenly spaced; `*/7` skews at the hour wrap"
- `90m` → "rounding 90m to 2h; cron's hour field can't express 1.5h"

## 4. Call the cron tool

With the parsed `cron` expression and `prompt`, invoke the `cron` tool's `schedule` verb. Use whichever call form the tool's own prompt describes — pass `cron` and `prompt` as required, leave `durable: false` (the default; only set true when the user explicitly asked the job to persist across sessions), leave it recurring (the default; one-shot is wrong for `/loop` — one-shots come from natural-language scheduling).

The cron tool returns a job id. Mention it briefly so the user can cancel with `/loops cancel <id>`.

## 5. Execute the prompt once immediately

After the cron call succeeds, **do not wait for the first scheduled tick**. Run the prompt body once right now:

- If the prompt starts with `/` (e.g. `/loop 5m /standup` → prompt is `/standup`), invoke it as a slash command — load the corresponding skill or command via the `skill` tool.
- Otherwise, act on the prompt directly in this turn.

This is the "don't make the user wait" rule. The cron job carries the recurring behavior; the immediate run is for responsiveness.

## 6. Examples

| User input | Interval | Cron | Prompt |
|---|---|---|---|
| `/loop 5m /babysit-prs` | `5m` (leading) | `*/5 * * * *` | `/babysit-prs` |
| `/loop check the deploy every 20m` | `20m` (trailing) | `*/20 * * * *` | `check the deploy` |
| `/loop /standup every 2 hours` | `2h` | `0 */2 * * *` | `/standup` |
| `/loop tidy inbox` | `10m` (default) | `*/10 * * * *` | `tidy inbox` |
| `/loop 30s ping` | `30s` → `1m` | `*/1 * * * *` | `ping` |
| `/loop 7m ping` | `7m` → `6m` (rounded, explain) | `*/6 * * * *` | `ping` |
| `/loop` | (usage hint) | — | — |
| `/loop 5m` | autonomous-only | (if enabled) | `<<autonomous-loop>>` |

## 7. Do not

- Do not invent intervals the user didn't ask for. If unsure, default to `10m` and say so.
- Do not pass `--one-shot`. This skill is for recurring loops.
- Do not list active jobs in your reply. Use `/loops` for that.
- Do not re-derive the cron expression in your reply unless the user asked. A one-line confirmation ("scheduled `<prompt>` every `<interval>`; job id `<id>`") is enough.
