---
feature: workspace-reminder
status: delivered
updated: 2026-11-04
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2776
---

# Keyed synthetic reminders and the session environment reminder

## Report

**What was built** — Synthetic user reminders are identified by `metadata.reminder = { key, rev }` through `SessionReminder.tag` / `has` / `windowTarget` (`packages/cli/src/session/reminder.ts`) instead of substring-matching their text. `ensurePersistedUserSynthetic` dedupes by tag; memory paths (`memory-paths`, rev = session memory dir), loop streak (`loop-streak`) and MCP (`mcp`, rev = existing MCP marker) are tagged, and `hasSyntheticReminder`, `memoryPathsReminderTarget` and `syntheticMarker` are gone. The run loop now injects a session environment reminder (session directory, git repository root when inside git, platform) once per context window, tagged `session-env` with rev = `Instance.directory`, before memory paths; every loop except bounded-computation agents gets it, including subagents. The system prompt and the dynamic system prompt flag are unchanged. Clients can tag their own synthetic parts through `TextPartInput.metadata`; a part with an identical tag is not duplicated by the engine. Related fix: the flag-gated Claude environment block names the shell the bash tool actually runs (`Shell.acceptable()`) instead of `Shell.preferred()`. Follow-up in the Desktop repository: on the MiMoCode engine path only, stop sending the `Working directory:` line of `runtimeContextNote` (keeping UI language); the evolve path does not run this engine and keeps it.

**Verification**

- `bun typecheck` (packages/cli) — PASS.
- `bun test test/session/synthetic-reminder.test.ts test/session/session-memory-dir-reminder-persist.test.ts test/session/rebuild-boundary-placement.test.ts test/session/title-first-turn.test.ts test/session/tool-gate-cancel.test.ts test/server/session-recovery.test.ts test/session/prompt-effect.test.ts test/actor/spawn.test.ts test/session/system.test.ts test/flag/dynamic-system-prompt-flag.test.ts` — 365 pass / 0 fail / 3 skip. The full suite is left to CI.
- Mutation checks: forcing the session environment gate on fails the bounded-agent test; forcing it off fails the main-session and subagent tests; removing the dynamic-flag gate in `SystemPrompt.environment()` fails "loop injects the dynamic environment block only when the flag is set".
- `bun test test/session/system.test.ts test/shell/shell.test.ts test/flag/dynamic-system-prompt-flag.test.ts` — 22 pass / 0 fail; the new `$SHELL=fish` case failed before the fix with `Shell: fish`.
- `oxlint` on the new files — 0 warnings; touched files have no new warnings versus base.
- Independent review: all acceptance criteria met; the one important finding (the flag-on test matched the session environment reminder) was fixed by asserting on system messages only.

## [S1] Problem

The runtime environment block (working directory, workspace root, git, platform) lives in `SystemPrompt.environment()` and is gated behind the opt-in `MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT` flag, so the system prefix stays byte-identical across projects and sessions. With the flag off — the default — the model is never told where it is: TUI, `mimo run`, and SDK sessions see no cwd at all, MiMo Desktop only covers the first user message of a root session, and both lose it after compaction or a checkpoint rebuild. Subagents running in their own worktree never see their directory.

Synthetic user reminders that must appear once per message or per context window are deduplicated by substring-matching their rendered text (`hasSyntheticReminder`, `ensurePersistedUserSynthetic`). That couples identity to wording and, for memory paths, embeds the varying value into the "marker".

## [S2] Design

### S2.1 Reminder tag

A synthetic text part may carry `metadata.reminder = { key: string, rev?: string }`.

- `key` names the reminder kind (`session-env`, `memory-paths`, `loop-streak`, `mcp`). Producers outside the engine use a namespaced key (for example `desktop.runtime`).
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

- session environment — never existed; added once to the newest unanswered user message.
- memory paths — the untagged copy is not recognized, so a tagged copy is appended once to the newest unanswered user message (identical content seen twice), then deduplicated.
- loop streak — a duplicate only if detection fires again on the same user message across the upgrade.
- MCP — none; re-announcement is decided by `metadata.mcpReminder`, which legacy parts already carry.

`windowTarget` only targets a user message with no assistant reply after it, so a re-added reminder never rewrites history already sent to the provider.

### S2.4 Session environment reminder

Rendered as one synthetic user part:

```
<system-reminder>
Session environment:
- Session directory: <Instance.directory>
- Git repository root: <Instance.worktree>     (git only; otherwise "- Not inside a git repository")
- Platform: <process.platform>
Relative paths in tool calls resolve against the session directory.
</system-reminder>
```

Wording rules:

- No "workspace": compose-style workflows treat the active workspace as a linked worktree they may create mid-session; a reminder titled "workspace" reads as "already chosen" and invites implementing on the base checkout. "Session directory" matches the bash tool's "defaults to the current session directory" and stays true after a worktree is created elsewhere.
- The git root is `Instance.worktree` (the checkout's top level, a linked worktree's own root) and is printed only when `project.vcs === "git"`; outside git `Instance.worktree` is `/`, which must never be shown as a root.
- No shell: the bash tool descriptions (`bash.txt`, `bash.gpt.txt`) already state OS and the shell they actually run (`Shell.acceptable()`). Platform stays because path semantics matter for file tools even when bash is unavailable.

Tag `{ key: "session-env", rev: Instance.directory }` (session cwd is immutable; `SessionCwd.get` returns `Instance.directory`). Placed with `windowTarget` at the same point in the run loop as memory paths, before it.

Gate: every run loop except bounded-computation agents (`native && hidden`, e.g. title, summary, compaction, checkpoint-writer), including subagents that do not serve checkpoints. Subagents spawned into their own directory see their own `Instance.directory`. A `context: "full"` subagent also sees the parent's copy through its inherited messages, which its own window does not include, so its request carries the reminder twice with identical content; accepted.

The dynamic system prompt flag and `SystemPrompt.environment()` are unchanged; with the flag on the cwd simply appears twice.

### S2.5 Reuse by MiMo Desktop

Desktop already sends synthetic text parts with `metadata` through `TextPartInput`, which the engine stores verbatim, so Desktop can give its own reminders a stable identity with namespaced keys (`desktop.*`). A part with an identical `key`/`rev` is recognized by `has`/`windowTarget`, but clients should not try to supersede `session-env`: its `rev` is the server-side realpath-normalized directory, which a client-sent path may not match byte for byte (symlinks, `/tmp` vs `/private/tmp`, Windows casing), and a mismatch yields two copies.

The follow-up Desktop change stops sending the `Working directory:` line of `runtimeContextNote` on the MiMoCode engine path (`SessionCommands`), keeping UI language; the evolve path runs a different engine and keeps it.

Client-owned reminders are still placed only on the message the client sends, so they are not re-added after compaction or a checkpoint rebuild. Desktop's remaining first-message facts (UI language, MCP config path) are not blocking when lost; an engine-side re-injection of client-declared window reminders is left for later (see S3).

### S2.6 Related fix: shell named in the Claude environment block

`SystemPrompt.environment()` (flag-gated, Claude template) advertised `Shell.preferred()`, while the bash tool runs `Shell.acceptable()`, which replaces blacklisted login shells (fish, nu) with a POSIX fallback. With `$SHELL` set to fish the block said `Shell: fish` while the bash tool description and execution used zsh. It now names `Shell.acceptable()`. `Shell.preferred()` stays for user-authored execution (`!` commands, command-template shell snippets, PTY), which handles fish and nu explicitly.

## [S3] Out of Scope

- Compose protocol promotion (`COMPOSE_REMINDER_MARKER`) and skill catalog recognition (`isSkillCatalogReminder`): their producers live outside this repository or carry legacy text-only data; migrating them needs coordinated producer changes.
- Restructuring MCP's announcement diff.
- `<vision-capability>` still sits behind the dynamic system prompt flag; moving it is a separate change.
- The Desktop-side deletion (S2.5) ships as a follow-up PR in the Desktop repository.
- Re-injecting client-owned reminders per context window (e.g. a client-declared `scope: "window"` replayed from the latest tagged part); not needed while the remaining Desktop first-message facts are non-blocking.

## Tasks

- [x] T1: `session/reminder.ts` with `tag`, `has`, `windowTarget` and unit tests — acceptance: tests cover tag validation, rev matching, ignored/non-synthetic exclusion, and every `windowTarget` branch (covers: S2.1, S2.2)
- [x] T2: migrate `ensurePersistedUserSynthetic`, memory paths, loop streak, MCP to tags; drop `hasSyntheticReminder`, `memoryPathsReminderTarget`, `syntheticMarker` — acceptance: existing memory-path, rebuild-placement, loop-streak and MCP reminder tests pass (covers: S2.3; depends: T1)
- [x] T3: inject the session environment reminder — acceptance: run-loop tests show it on the first window's user message for a main session, re-added after a boundary, present for a subagent, absent for a bounded-computation agent, and not duplicated when the user message already carries a client-supplied part with the same tag (covers: S2.4, S2.5; depends: T2)

## Journey log

- The first cut titled the reminder "Workspace for this conversation" with a `Workspace root` line and the preferred shell. Review of the wording found three problems: "workspace" collides with compose-style worktree ownership, `Instance.worktree` is `/` outside git, and `Shell.preferred()` can differ from the bash tool's `Shell.acceptable()` while the tool description already states the real shell. Renamed to `session-env` before merge; no persisted data used the old key.
