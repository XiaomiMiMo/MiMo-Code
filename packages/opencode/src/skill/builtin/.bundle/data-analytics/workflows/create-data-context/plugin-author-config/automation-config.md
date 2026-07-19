# Data Analytics Automation Config

Plugin authors edit this file when adding, removing, renaming, or clarifying default Data Analytics automations. Keep setup mechanics, thread creation, pinning, readback, duplicate cleanup, failure handling, and automation tool usage in `../references/automation.md`.

Default automations are offered when their prerequisites are met. Later journey automations are offered only when a focused workflow reaches the right point. This config should stay friendly for plugin authors: name the automation, say how often it should run, and write the instructions. The dedicated thread title is derived from `Name`. Runtime mechanics such as heartbeat kind, RRULE conversion, tool calls, target thread ids, pinning, readback, cleanup, and state metadata belong in `../references/automation.md`.

## Automation Entry Shape

Every automation entry must use this shape:

```md
`automation_id`

- Name: human-facing automation name.
- Frequency: Data Analytics user-facing cadence and local time.
- Instructions: thin launcher instructions for the scheduled run.
```

Do not add model, reasoning effort, heartbeat kind, RRULEs, tool names, user-specific target thread ids, canonical automation ids, install status, readback evidence, cleanup state, notification copy, or per-user preferred times here. Those belong in `../references/automation.md` or in the explicitly created automation/thread artifacts, not in hidden local setup or context state.

## Default Automations

`weekly_semantic_layer_refresh`
- Name: Semantic Layer Weekly Source Polling.
- Frequency: weekly on Mondays at 9:00 AM local time.
- Instructions: Check the saved semantic-layer source inventory for source-backed changes, propose safe updates, validate any edited semantic-layer skill, and report conflicts, skipped sources, or permission gaps.
