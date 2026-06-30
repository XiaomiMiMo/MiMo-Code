---
name: proactive
description: Alias for the `loop` skill. Schedule a prompt to fire on a fixed cadence. Use when the user invokes `/proactive` directly or asks to "be proactive about X every N minutes". Follow the same parsing, cron-mapping, and immediate-execute rules as `/loop`.
---

# /proactive — alias for `/loop`

This skill is an alias. Apply the exact rules from the `loop` skill:

1. Parse `[interval] <prompt>` using the three-rule priority (leading `\d+[smhd]` token → trailing `every <N><unit>` clause → default `10m`).
2. Map the interval to a 5-field cron expression via the lookup table; round to the nearest clean cadence and tell the user when you do.
3. Call the `cron` tool with `{"operation":{"action":"schedule","cron":"<expr>","prompt":"<prompt>"}}` — `durable: false`, recurring.
4. Empty prompt with the autonomous-loop opt-in enabled → use the `<<autonomous-loop>>` sentinel as the prompt body.
5. After scheduling, execute the parsed prompt once immediately so the user sees activity now, not at the first tick.

For the full table, rounding examples, and edge cases, see the `loop` skill.
