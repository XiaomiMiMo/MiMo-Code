---
feature: skill-catalog-live
status: delivered
updated: 2026-11-20
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2840
---

# Skill Catalog Live

## Report

**What was built** — Skill discovery is a per-directory snapshot refreshed at its triggers: the user-turn boundary, `Command.list`/`get`, `GET /skill`, and a name miss in `skill`/`skill_search`. Each refresh globs the existing roots and reparses only `SKILL.md` files whose `(path, mtime, size)` changed. Refreshes are single-flight with tickets, so a caller never accepts a scan that started before its request, and an interrupted scan cannot wedge later callers. Builtin extraction runs once per process; an empty remote pull is retried after 5 minutes.

The catalog left the system tail. It is a persisted user-turn reminder tagged `skillReminder`: a full entry per context window, then deltas listing added or changed skills and removed names. It is appended only before the turn's first assistant step. The system prompt no longer depends on skills, so it stays byte-stable while skills change.

Prefixes frozen by older engines have their catalog block stripped once through `SessionPrefixSnapshot.getFrozen`, in the main loop, prefix capture, and compaction. Host-supplied copies of that block are kept. Legacy user-side catalogs stay suppressed.

Slash commands list live skills without waiting for MCP servers: MCP prompt commands are collected in the background, and `get` waits for them only on a miss. The agent permission is unchanged, which keeps the prefix profile key stable.

**Verification** — From `packages/cli`. The full suite was not run locally; it is slow, CI runs it, and CI isolates the MCP mock suites.
- PASS — `bun run typecheck` on the final head.
- PASS — related tests at `ac91189c`: 268 tests (skill, catalog, system, message-v2, prefix and fork prefix, tool skill and skill-search, command, agent, installation, mcp-singleton) and 304 tests (prompt-effect, prompt-skill-command-multi, title-first-turn, rebuild boundary and tail-digest, checkpoint-fork-mode, session-recovery). 0 failed.
- PASS — after review fixes: the 6 related files, 56 tests; `prompt-effect -t compaction`, 9 tests; delta and legacy prompt-loop tests; `skill-catalog.test.ts`, 12 tests.
- PASS — `test/command/command-live.test.ts` times out against the old `Command`, confirming the regression test.
- PASS — oxlint on changed files shows no diagnostics beyond the main baseline; `git diff --check` is clean.
- PRE-EXISTING — `test/mcp/*` mock suites fail when they share a process with other files. CI runs them isolated (`.github/workflows/test.yml`).
- PASS — independent review plus two follow-up reviews. Both major findings were resolved: the profile-key churn from rebuilding the agent, and the refresh interruption hang. A later deny-bypass finding was resolved by dropping that code.

## [S1] Problem

Skill discovery is cached for the life of the process. Global roots and builtin skills sit in a process-wide cache that never expires. Project, config, and `skills.paths` roots are cached per instance directory and are cleared only when that instance is disposed. After the first conversation in a directory, a skill that is added, edited (including its `SKILL.md` body), or removed stays invisible to every later conversation until the process restarts. The only automatic refresh happens when the agent's `write`/`edit` touches `.mimocode/skill(s)/`.

The catalog also lives in the system tail and is frozen into `SessionPrefixSnapshot`. The system prompt therefore varies with each project's skill set, and a session can never learn about a skill change.

Slash completion (`GET /command`) has the same staleness: `Command` caches its list per directory, including skills. It also builds that list only after `MCP.prompts()`, which awaits `settled` for every MCP server. Before the slowest MCP server connects or fails, slash completion shows nothing, including no skills.

## [S2] Design

### S2.1 Scan at the trigger

Skill discovery becomes a snapshot computed when it is needed, with no time-based expiry:

- **Triggers**: the user-turn boundary before the catalog reminder (S2.2), `Command.list`/`Command.get` (S2.5), `GET /skill`, and a name miss in the `skill` tool or `skill_search` (one rescan, then report not found). Inside a turn, later steps reuse the snapshot taken at that turn's boundary.
- **Per refresh**: recompute the root list from the current config and directory, glob every root with the existing patterns, and parse each `SKILL.md` through a cache keyed by `(path, mtimeMs, size)`. Unchanged files are not parsed again, and a failed parse is cached too, so its error is reported once per file version. When the inputs are unchanged, the previous snapshot object is kept.
- **Process-wide one-offs**: builtin bundle extraction runs once per process (its marker check is unchanged). Each remote `skills.urls` entry is pulled once per process and reused afterwards; an empty result (possibly a network failure) is retried after 5 minutes. `Skill.reload()` keeps its meaning: it re-extracts, clears the pull and parse caches, and rescans.
- **Concurrency**: refreshes for the same directory are single-flight. Each call takes a ticket and may only join a scan that started after its ticket was issued, so it always sees disk state at least as new as its request. An interrupted scan satisfies no one; waiters scan again. The first access to a directory scans once and counts as fresh.
- **Cost**: measured on a developer machine, all roots globbed in ~7 ms and 39 `SKILL.md` files parsed in ~5 ms warm (~19 ms cold). A cached-parse refresh stays in that range, which is negligible next to a model request. This is why the design does not add a file watcher or directory-mtime fingerprint gate.
- **Unchanged rules**: directory layout rules, scan roots, external-root flags, duplicate-name precedence, and frontmatter validation are unchanged.

`Skill.Interface` gains `refresh(): Effect<void>`, which updates the current directory's snapshot. `get`, `all`, `available`, `modelInvocable`, and `dirs` read the latest snapshot and never trigger a scan themselves. The S2.5 command path is the exception: it calls `refresh()` first.

### S2.2 Catalog as a user-turn reminder with deltas

The catalog moves from the system tail to persisted synthetic text parts on the last user message, following the MCP reminder model:

- **Timing**: inject only while the last user message is still the tail of the conversation, before this turn's first assistant step. Changes that happen mid-turn wait for the next user turn. Content already sent is never rewritten.
- **Entry reminder**: when no catalog state can be replayed from the current history (new session, after compaction, or a legacy session per S2.4), inject the full catalog. It uses the existing verbose `<available_skills>` format plus usage guidance (call the `skill` tool with the exact name before following a skill).
- **Delta reminder**: when the current catalog differs from the latest announced state, inject one reminder that lists added and changed skills as full entries and removed skills by name. Removed skills must not be used. Nothing is injected when nothing changed.
- **Fingerprint**: each skill's fingerprint is a SHA-256 over `{name, description, location}` serialized as structured data. Body edits do not produce a reminder because the body is read at load time (S2.1 keeps it fresh).
- **Replay**: replay part metadata `skillReminder: { kind: "entry" | "delta", skills: Record<name, fingerprint> }` in conversation order to reconstruct the latest announced state. The `SessionReminder` tag is `{ key: "skills", rev: "skills:<kind>:<sha256 of the resulting state>" }`.
- **Visible set**: `modelInvocable(agent with runtime permission)`. When the `skill` permission is disabled, the visible set is empty, so any previously announced skills are retracted and no entry is injected.
- **Subagents and forks**: a new subagent session gets its own entry reminder on its first turn. A full-context fork inherits the parent's announced parts and therefore receives only deltas.

### S2.3 System prompt no longer carries skills

- Remove `SystemPrompt.skills` from both system-tail assemblies: the main loop and checkpoint prefix capture. `llm-request-prefix` parity is preserved.
- New `SessionPrefixSnapshot` entries no longer contain a catalog, so they stay stable when skills change.
- The prompt texts that say the catalog is "in the system prompt" now say it arrives in reminders, which may later announce additions, changes, and removals: `tool/skill.txt`, `session/prompt/gpt.txt`, and `session/prompt/default.txt`.

### S2.4 Legacy sessions

- **Legacy frozen prefix**: when a reused frozen system contains an element with the legacy catalog marker (`Skills available in this session:`), drop that element. Rotate the snapshot once so the stored system and its hash match the new system. This costs a single prefix-cache miss right after the upgrade.
- **Catalog after upgrade**: the legacy session then receives an entry reminder on its next user turn, which is what happens when an old conversation is resumed after a restart.
- **Provider conversion** (`message-v2`): keep suppressing legacy synthetic catalog parts (marker text without `skillReminder` metadata). Parts that carry `skillReminder` are always delivered.

### S2.5 Commands are live and do not block on MCP

- `Command` caches the static and config-derived commands per directory.
- MCP prompt commands are collected in the background once every MCP server has settled (same timing and content as before). `list` never waits for them; `get` waits for the collection only when a name is not found yet.
- `list`/`get` compose the cached commands, the MCP prompt commands, and the current skills after `Skill.refresh()`.
- Name precedence is unchanged: MCP prompts override built-in/config commands of the same name, and skills never override anything.
- Slash completion therefore shows skills before every MCP server settles, and a new skill appears on the next `GET /command`. The desktop menu already revalidates every time it opens.

### S2.6 Agent permission stays fixed

The agent permission, including its startup allowlist of skill directories for `external_directory`, is not rebuilt when skills change. `SessionPrefixSnapshot.profileKey` hashes the agent permission, so rebuilding it would re-pin frozen prefixes mid-turn and make compaction miss its snapshot. Reading a skill created outside the project after startup asks for `external_directory` permission as before.

### S2.7 Testing boundaries

Tests use real temp directories and the real session loop, with no mocking of `Skill` internals. They must show that:

- adding, editing, or removing a skill on disk is reflected on the next user turn and by the next `GET /command`;
- the entry reminder appears once per compaction window;
- deltas cover add, change, and remove, and no reminder is injected when nothing changed;
- nothing is appended mid-turn;
- a legacy frozen system is stripped and the session receives an entry on its next turn;
- legacy user-side catalogs stay suppressed;
- slash commands still return skills while an MCP server is pending.

### S2.8 Known limitation

The `external_directory` allowlist for skill directories is fixed when the agent is first built for a directory. Reading files of a skill created outside the project after that point asks for `external_directory` permission once, and the user can allow it permanently. A skill directory removed after startup stays allowlisted until the process restarts. This is accepted: catalog visibility and skill loading are live; only this permission convenience is not.

## [S3] Out of Scope

- Changing skill directory layout rules (recursive `**/SKILL.md` stays). The open standard does not mandate a flat layout, and recursion costs ~2–3 ms more than a one-level glob on measured roots.
- Follow-up (desktop): the desktop provisions `engine-config/skills/mimo-browser-use/mimo-browser-use/SKILL.md`, an accidental double nesting. Fix its packaging to `mimo-browser-use/SKILL.md` together with the desktop pin bump and R14 spec revision.
- File watchers or push notifications for skill changes.
- A token budget for the catalog (the system tail has none today).
- External-root on/off flags (still read at startup).
- Trusting skill directories created after startup in the `external_directory` guard (see S2.8). A trust exemption that returns before asking would bypass explicit deny rules; doing it safely needs a deny-aware check and is a separate change.
- Desktop changes. The desktop updates its engine pin and revises its prompt-assembly R14 spec in its own repository.

## Tasks

- [x] T1: Live skill snapshot with parse cache, single-flight `refresh()`, process-once builtin extraction and URL pulls — acceptance: a unit test adds, edits, and removes `SKILL.md` files under real temp roots and observes `refresh()` reflect each change; an unchanged file is not reparsed. (covers: S2.1)
- [x] T2: Turn-boundary skill reminders (entry and delta) via `ensurePersistedUserSynthetic` and `skillReminder` replay — acceptance: prompt-loop tests show an entry on the first turn, a delta after add/change/remove, nothing when unchanged, nothing mid-turn, and an entry again after compaction. (covers: S2.2, depends: T1)
- [x] T3: Remove skills from the system tail in both assemblies; update the prompt texts — acceptance: the request system contains no catalog, and existing prefix-parity tests pass. (covers: S2.3, depends: T2)
- [x] T4: Legacy handling — strip the catalog from frozen systems with a one-time rotate; keep suppressing legacy user-side parts — acceptance: a session pinned with a legacy catalog sends a stripped system and receives an entry reminder on its next turn. (covers: S2.4, depends: T3)
- [x] T5: Live `Command.list`/`get` with non-blocking MCP prompts — acceptance: `GET /command` lists a newly created skill without a restart and returns skills while an MCP server is still pending. (covers: S2.5, depends: T1)
- [x] T6: Skill changes never change the agent permission — acceptance: adding, removing, and editing skills across turns keeps a single prefix snapshot for the session. (covers: S2.6, depends: T2)

## Journey log

- First version of S2.6 rebuilt the agent when skill directories changed. Review found this changes the prefix profile key (it hashes the agent permission), re-pinning frozen prefixes mid-turn and breaking compaction's snapshot lookup. A second attempt trusted live skill directories inside the `external_directory` guard, but an early return there bypasses explicit deny rules. Dropped both; the agent permission stays fixed and post-startup trust is out of scope.
- Considered one-level-only discovery to cut scan cost. Measurement showed glob is not the cost (≈7 ms recursive vs ≈4 ms flat across all roots); parsing is, and a stat-keyed parse cache removes it. Kept recursion; the only nested layout found locally (desktop `mimo-browser-use`) is a packaging bug tracked as a desktop follow-up.
