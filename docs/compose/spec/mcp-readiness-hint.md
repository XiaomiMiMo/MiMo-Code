---
feature: mcp-readiness-hint
status: in-progress
updated: 2026-10-20
branch: feat/example # Synthetic label per repository documentation conventions
commits:
---

# MCP Readiness Hint

## Report

## [S1] Problem

The model cannot tell **MCP is not ready** from **the tool does not exist**. Announcements were catalog-delta-driven, so “which MCPs exist / are connecting” was missing or delayed, and empty search reused one ambiguous sentence.

Readiness reminders must also stay accurate without accumulating repeated failures. A conversation-wide set of previously seen states suppresses recovery after `connected → failed → connected`. Ignoring disabled or removed servers leaves stale availability claims in history. Advertising a server's raw tool list can recommend tools that request permissions hide, while allocating a full context budget to every server multiplies the total reminder size.

## [S2] Design

### Channels and timing

| Channel | When | Content |
|---|---|---|
| Entry reminder | user-turn boundary, non-disabled configured servers, deferred search exposed | configured server names, possible pending work, notification timing, search/use hint |
| Server outcome reminder | user-turn boundary, changed status or request-visible tool names | connected: names + description previews; unavailable: a short state and relevant action |
| `mcp_tool_search` | on use | full schemas on hit; readiness + action hint on empty/miss |
| `mcp_tool_use` | on use | result; unknown/unavailable name points back to search |

`MCP.readiness()` is optional on the MCP service interface and never awaits connection `settled`. It reports configured server names, connection status, errors where applicable, and connected tools. `resolveTools` refreshes the model-facing snapshot on each model step; a search uses that step's snapshot. Connection changes during model generation are picked up at the next resolution, not pushed into an in-flight request.

Reminders are persisted synthetic text parts on the last user message through `ensurePersistedUserSynthetic`. They are appended only before that user's first assistant step. Earlier messages and the provider-facing search/use definitions remain unchanged during a turn. This preserves the existing prefix-cache contract. These reminders apply where deferred `mcp_tool_search` is exposed; the GPT/`exec` and direct-tool paths retain their existing behavior.

### Latest-state comparison and bounded repetition

Replay `mcpReminder` metadata in conversation order into the latest entry and the latest state per server. Compare the current semantic fingerprint with that server's **latest reported state**, rather than a set of every state ever seen. A fingerprint includes server identity, status, and sorted request-visible tool names. Hash the structured values to avoid delimiter collisions. Error text and tool ordering do not trigger a new reminder.

| Observed transition | Required behavior |
|---|---|
| `failed → failed`, including different error details | no additional failure reminder |
| `connected → failed → connected` | report the failure and subsequent recovery |
| tools `{a,b} → {a} → {a,b}` | retract `b`, then announce the restored set |
| connected → pending / disabled / removed | report the changed state once and invalidate earlier tool availability |
| initially pending → disabled / removed before any outcome | report the change once; the entry retains the server's presence |
| initially disabled, or no configured servers and no previous announcements | no ambient reminder |

Previously announced servers absent from the current configuration receive a `removed` reminder. Repeated absence stays quiet. On disconnection, the new reminder briefly states that previously listed tools are unavailable; on a shrinking visible tool set, it names removed tools when the budget allows and otherwise uses a compact superseding statement. Deferral is recorded once as ignored, empty synthetic metadata whenever search is exposed. This record is never sent to the model, so silent entry states and budget omission still preserve sticky deferral without adding text. Legacy `mcpDeferredTools` metadata remains recognized when resuming older sessions. Compaction can discard that evidence and cause a fresh announcement, because it already rewrites the prefix.

### Connection state and request-visible capabilities

Connection state comes from MCP readiness and is never inferred from an empty search catalog. Before presenting tools to the model, intersect each connected server's tool names with the same catalog used by search and dispatch. That catalog applies request disables, permissions, agent allowlists, actor whitelists, executable checks, and local-name collision handling. List each surviving name once, use the catalog's description, and compute the displayed count from this filtered list. This does not change MCP registration or resolve ambiguous ownership between colliding server namespaces.

Consequently, a server can be **connected with no tools available to this request**. Do not claim the server itself exposes no tools. The reminder must never recommend a name that the current search/dispatch view excludes. The model receives names and short descriptions for discovery; complete parameter schemas remain on-demand through search.

### One reminder budget per boundary

Entry plus all changed-server reminders share `min(floor(usable_input_tokens × 0.1), 20,000)` estimated tokens. The existing unknown-context fallback remains 20,000; an exhausted known window has zero budget. Deduct each emitted part, including a separator allowance, then divide the remaining budget among remaining changed servers.

Count the entire text, including wrappers, status, instructions, diagnostics, and retractions. Connected tools fall back from descriptions to names, then a truncated list with a search hint, then compact status. Diagnostic previews and large retraction lists are bounded. Search-miss diagnostics reuse the same normalization and harness-tag escaping as reminders. If even a compact reminder cannot fit, emit no part and do not mark that outcome as delivered. Search still covers the complete authorized catalog.

### Keep the mechanism and prompts simple

Only report the server's current status, a short diagnostic when useful, and available tool names/descriptions with a search/use pointer. Avoid repeated instructions telling the model what to infer from a failure or how to work around the user's MCP setup. Ordinary ambiguity in invalid or conflicting MCP configuration is outside this amendment; preserve existing registration behavior.

### Verification boundaries

Use the real prompt serialization path with controlled MCP service snapshots to inspect what reaches the test model endpoint. Cover state recurrence, changing error details, disable/removal before and after connection, restored tool sets, request/permission/agent filtering, and a shared multi-server budget. Unit tests cover rendering, tiny/zero budgets, long errors and retractions, fingerprints, and escaped readiness/search output. Prompt tests also cover silent auto-mode entry, legacy mode evidence, and duplicate names within a server. Existing MCP integration tests protect prefix stability, sticky deferral, dispatch, lifecycle, and result handling. These tests establish context correctness; they do not measure a real model's tool-selection success rate.

## [S3] Out of Scope

- Changing `FIRST_TURN_WAIT` or connection lifecycle.
- Mid-turn ambient push into history.
- Full JSON Schema validation of `mcp_tool_use` arguments.
- Consuming `MCP.ToolsChanged` as a dirty signal.
- Extending readiness reminders to GPT/`exec` or non-deferred tool exposure.
- Empirical evaluation of real-model tool-selection success rates.
- Repairing user MCP configuration, changing normalized-name registration ownership, or distinguishing all ambiguous cross-server name collisions.

## Tasks

- [ ] T4: Compare the latest server state — acceptance: repeated failures and error-detail changes add no reminder; failure/recovery and tool-set recurrence each reach the model (covers: S2)
- [ ] T5: Report unavailable and removed servers — acceptance: pending, disabled, and removed transitions invalidate prior tool availability once; pending-server removal is covered; initially disabled servers remain quiet (covers: S2)
- [ ] T6: Align advertised tools with request authorization — acceptance: request disables, permissions, and agent allowlists hide the same tools from reminders and search, with matching visible counts (covers: S2)
- [ ] T7: Enforce a shared reminder budget — acceptance: multi-server serialized reminders remain within one budget; long diagnostics, retractions, and zero budgets are covered without marking omitted outcomes delivered (covers: S2)
- [ ] T9: Persist deferral without visible text — acceptance: unconfigured, disabled, and budget-omitted initial states retain search/use with no ambient text; legacy announcements still lock deferral (covers: S2)
- [ ] T10: Keep diagnostics safe and prompts concise — acceptance: search-miss names/errors use existing escaping and preview bounds; reminders contain status, tools, and a brief search/use pointer (covers: S2)
- [ ] T8: Verify and independently review the integrated feature — acceptance: focused MCP suites and typecheck pass, lint introduces no diagnostics, and spec compliance/correctness/codebase consistency have no unresolved critical findings (covers: S2; depends: T4, T5, T6, T7, T9, T10)
