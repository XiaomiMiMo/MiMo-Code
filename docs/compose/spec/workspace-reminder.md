---
feature: workspace-reminder
status: delivered
updated: 2026-10-01
source: feat/workspace-reminder
---

# Keyed synthetic reminders and the workspace reminder

## Report

**What was built** — Synthetic user reminders are identified by `metadata.reminder = { key, rev }` through `SessionReminder.tag` / `has` / `windowTarget` (`packages/cli/src/session/reminder.ts`) instead of substring-matching their text. `ensurePersistedUserSynthetic` dedupes by tag; memory paths (`memory-paths`, rev = session memory dir), loop streak (`loop-streak`) and MCP (`mcp`, rev = existing MCP marker) are tagged, and `hasSyntheticReminder`, `memoryPathsReminderTarget` and `syntheticMarker` are gone. The run loop now injects a workspace reminder (working directory, workspace root, git, platform, shell) once per context window, tagged `workspace` with rev = `Instance.directory`, before memory paths; every loop except bounded-computation agents gets it, including subagents. The system prompt and the dynamic system prompt flag are unchanged. A client part carrying the same tag (e.g. from MiMo Desktop through `TextPartInput.metadata`) suppresses the engine copy. Follow-up in the Desktop repository: drop the `Working directory:` line from `runtimeContextNote`, keeping UI language.

**Verification**

- `bun typecheck` (packages/cli) — PASS.
- `bun test test/session/synthetic-reminder.test.ts test/session/session-memory-dir-reminder-persist.test.ts test/session/rebuild-boundary-placement.test.ts test/session/title-first-turn.test.ts test/session/tool-gate-cancel.test.ts test/server/session-recovery.test.ts test/session/prompt-effect.test.ts test/actor/spawn.test.ts test/session/system.test.ts test/flag/dynamic-system-prompt-flag.test.ts` — 365 pass / 0 fail / 3 skip. The full suite is left to CI.
- Mutation checks: forcing the workspace gate on fails the bounded-agent test; forcing it off fails the main-session and subagent tests; removing the dynamic-flag gate in `SystemPrompt.environment()` fails "loop injects the dynamic environment block only when the flag is set".
- `oxlint` on the new files — 0 warnings; touched files have no new warnings versus base.
- Independent review: all acceptance criteria met; the one important finding (the flag-on test matched the workspace reminder) was fixed by asserting on system messages only.

## [S1] Problem

The runtime environment block (working directory, workspace root, git, platform) lives in `SystemPrompt.environment()` and is gated behind the opt-in `MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT` flag, so the system prefix stays byte-identical across projects and sessions. With the flag off — the default — the model is never told where it is: TUI, `mimo run`, and SDK sessions see no cwd at all, MiMo Desktop only covers the first user message of a root session, and both lose it after compaction or a checkpoint rebuild. Subagents running in their own worktree never see their directory.

Synthetic user reminders that must appear once per message or per context window are deduplicated by substring-matching their rendered text (`hasSyntheticReminder`, `ensurePersistedUserSynthetic`). That couples identity to wording and, for memory paths, embeds the varying value into the "marker".

## [S2] Design

### S2.1 Reminder tag

A synthetic text part may carry `metadata.reminder = { key: string, rev?: string }`.

- `key` names the reminder kind (`workspace`, `memory-paths`, `loop-streak`, `mcp`). Producers outside the engine use a namespaced key (for example `desktop.runtime`).
- `rev` is the value the content depends on (a directory, a content hash). Two parts are the same reminder when `key` and `rev` are equal; a missing `rev` matches only a missing `rev`.
- Only non-ignored synthetic text parts count. Text content is never inspected.

`TextPart.metadata` is already a free-form record and `TextPartInput` already carries it, so no schema or SDK change is required. The tag is read through a validating accessor; malformed values are treated as untagged.

### S2.2 Helpers (`session/reminder.ts`)

- `tag(part)` — the validated tag or `undefined`.
- `has(parts, { key, rev })` — whether a message's parts carry the tag.
- `windowTarget({ msgs, sessionID, reminder })` — the user message that should receive a once-per-context-window reminder, or `undefined` when the window already carries it. The rule is the one memory paths already used: `msgs` begins at the latest checkpoint/compaction boundary; prefer the window's first own user message if no non-summary assistant reply follows it, otherwise the newest own user message if still unanswered, otherwise nothing (never rewrite sent history).

### S2.3 Persisting

`ensurePersistedUserSynthetic({ message, reminder, text, metadata? })` skips when `has(message.parts, reminder)`, otherwise persists a synthetic text part whose metadata is `{ ...metadata, reminder }`. The legacy `syntheticMarker` field and text matching are removed.

Migrated callers:

- memory paths → `{ key: "memory-paths", rev: <session memory dir> }`, placed with `windowTarget`.
- loop streak → `{ key: "loop-streak" }`.
- MCP → `{ key: "mcp", rev: mcpReminderMarker(meta) }`. MCP's own announcement diff (`announcedMcpReminders` over `metadata.mcpReminder`) is unchanged.

Parts written before this change carry no tag. No compatibility shim; the per-kind effect on an existing session:

- workspace — never existed; added once to the newest unanswered user message.
- memory paths — the untagged copy is not recognized, so a tagged copy is appended once to the newest unanswered user message (identical content seen twice), then deduplicated.
- loop streak — a duplicate only if detection fires again on the same user message across the upgrade.
- MCP — none; re-announcement is decided by `metadata.mcpReminder`, which legacy parts already carry.

`windowTarget` only targets a user message with no assistant reply after it, so a re-added reminder never rewrites history already sent to the provider.

### S2.4 Workspace reminder

Rendered as one synthetic user part:

```
<system-reminder>
Workspace for this conversation:
- Working directory: <Instance.directory>
- Workspace root: <Instance.worktree>
- Git repository: yes|no
- Platform: <process.platform>
- Shell: <preferred shell name>
Relative paths in tool calls resolve against the working directory.
</system-reminder>
```

Tag `{ key: "workspace", rev: Instance.directory }` (session cwd is immutable; `SessionCwd.get` returns `Instance.directory`). Placed with `windowTarget` at the same point in the run loop as memory paths, before it, so a fresh window gets workspace then memory paths.

Gate: every run loop except bounded-computation agents (`native && hidden`, e.g. title, checkpoint writer, compaction), including subagents that do not serve checkpoints. Subagents spawned into their own directory see their own `Instance.directory`. A `context: "full"` subagent also sees the parent's copy through its inherited messages, which its own window does not include, so its request carries the reminder twice with identical content; accepted.

The dynamic system prompt flag and `SystemPrompt.environment()` are unchanged; with the flag on the cwd simply appears twice.

### S2.5 Reuse by MiMo Desktop

Desktop already sends synthetic text parts with `metadata` through `TextPartInput`, which the engine stores verbatim. A Desktop part tagged with the same `key`/`rev` is recognized by `has`/`windowTarget`, so Desktop can mark its own reminders with namespaced keys and can supersede an engine reminder by sending the identical tag. The follow-up Desktop change removes the `Working directory:` line from `runtimeContextNote` (keeping UI language) because the engine now owns cwd.

## [S3] Out of Scope

- Compose protocol promotion (`COMPOSE_REMINDER_MARKER`) and skill catalog recognition (`isSkillCatalogReminder`): their producers live outside this repository or carry legacy text-only data; migrating them needs coordinated producer changes.
- Restructuring MCP's announcement diff.
- `<vision-capability>` still sits behind the dynamic system prompt flag; moving it is a separate change.
- The Desktop-side deletion (S2.5) ships as a follow-up PR in the Desktop repository.

## Tasks

- [x] T1: `session/reminder.ts` with `tag`, `has`, `windowTarget` and unit tests — acceptance: tests cover tag validation, rev matching, ignored/non-synthetic exclusion, and every `windowTarget` branch (covers: S2.1, S2.2)
- [x] T2: migrate `ensurePersistedUserSynthetic`, memory paths, loop streak, MCP to tags; drop `hasSyntheticReminder`, `memoryPathsReminderTarget`, `syntheticMarker` — acceptance: existing memory-path, rebuild-placement, loop-streak and MCP reminder tests pass (covers: S2.3; depends: T1)
- [x] T3: inject the workspace reminder — acceptance: run-loop tests show it on the first window's user message for a main session, re-added after a boundary, present for a subagent, absent for a bounded-computation agent, and not duplicated when the user message already carries a Desktop-supplied part with the same tag (covers: S2.4, S2.5; depends: T2)
