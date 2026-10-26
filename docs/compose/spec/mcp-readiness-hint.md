---
feature: mcp-readiness-hint
status: delivered
updated: 2026-10-20
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2685
---

# MCP Readiness Hint

## Report

**What was built** — Deferred MCP discovery reports configured servers, current connection status, and request-visible tool names/descriptions. Reminders compare against the latest reported server state, so unchanged failures stay quiet while recovery, disable/removal, and changed tool sets are reported. All reminders share one budget; diagnostics use existing preview and escaping helpers. Prompts contain concise status, tools, and search/use pointers.

No auxiliary mode state is written into user history. Existing real reminders and search/use calls provide deferral evidence; silent auto-mode sessions may re-evaluate when tools arrive. This accepts a cache change instead of altering original user messages for bookkeeping. MCP connection, permission, dispatch, registration, and storage implementations remain unchanged. One actor guard test now explicitly provides the Inbox and verifies actual delivery, removing a dependency on prior test initialization.

**Verification** — Run from `packages/cli` unless stated otherwise, for final code head `5d6de390`:

- PASS — `bun test test/session/prompt-effect.test.ts --timeout 30000`: 135 passed, 3 skipped, 0 failed. Includes the full resume and MCP suites. The final assertion-only cleanup was rechecked with `-t 'MCP auto mode can'`: 1 passed.
- PASS — `bun test test/server/session-recovery.test.ts test/session/title-first-turn.test.ts test/session/tool-gate-cancel.test.ts test/server/session-select.test.ts test/tool/actor.test.ts test/tool/actor-send.test.ts test/tool/mcp-tool-search.test.ts --timeout 30000`: 200 passed, 0 failed.
- PASS — `bun run typecheck`: exit 0 on the final code head.
- PASS — repository-root oxlint on the two changed MCP source files and the prompt-effect, mcp-tool-search, and actor tests: 0 errors and no new diagnostics. **PRE-EXISTING LINT-141**: 134 existing MCP-file warnings plus 7 existing actor-test warnings, compared by file, rule, message, and severity.
- PASS — repository root: `git diff --check`.
- PASS — independent MCP review and final scoped review of `e5f2a933..5d6de390`: spec compliance, correctness, and codebase consistency approved; no critical or blocking findings. The final documentation-only commit is excluded from the recorded range. Green remote CI is required before merge.

**Journey log**

- Readiness answers whether a server is connected; the authorized catalog answers which tools this request can use.
- Comparing with every historical state suppressed recovery. Compare with the latest state while ignoring volatile error details.
- Budget the complete set of reminders together, including status text and retractions, rather than allocating a full budget to every server.
- An auxiliary hidden mode marker caused ten CI failures by modifying original user messages during resume and related flows. It was removed entirely; no replacement storage mechanism was introduced. Auto-mode re-evaluation without actual reminder/call evidence is accepted.
- Another CI failure came from an actor test assuming Inbox was uninitialized. Explicit fixture setup and real delivery assertions fixed the test without changing actor behavior. Keep prompts and mechanisms simple; user configuration repair and cross-server ownership ambiguity stay out of scope.

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

Reminders are persisted synthetic text parts on the last user message through `ensurePersistedUserSynthetic`. They are appended only before that user's first assistant step. Already-sent message content is not rewritten by visible reminders. Deferred search/use definitions stay stable while deferral remains selected; an empty, silent auto-mode session can re-evaluate the mode when tools arrive. This preserves the existing prefix-cache contract. These reminders apply where deferred `mcp_tool_search` is exposed; the GPT/`exec` and direct-tool paths retain their existing behavior.

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

Previously announced servers absent from the current configuration receive a `removed` reminder. Repeated absence stays quiet. On disconnection, the new reminder briefly states that previously listed tools are unavailable; on a shrinking visible tool set, it names removed tools when the budget allows and otherwise uses a compact superseding statement. Actual MCP reminders and search/use calls provide the existing evidence for sticky deferral, including legacy `mcpDeferredTools` announcements. If none exists, `auto` may re-evaluate when tools arrive; a cache change in that case is accepted. Do not persist an auxiliary mode marker or modify an original user message merely to retain a cache decision. Compaction can discard that evidence and cause a fresh announcement, because it already rewrites the prefix.

### Connection state and request-visible capabilities

Connection state comes from MCP readiness and is never inferred from an empty search catalog. Before presenting tools to the model, intersect each connected server's tool names with the same catalog used by search and dispatch. That catalog applies request disables, permissions, agent allowlists, actor whitelists, executable checks, and local-name collision handling. List each surviving name once, use the catalog's description, and compute the displayed count from this filtered list. This does not change MCP registration or resolve ambiguous ownership between colliding server namespaces.

Consequently, a server can be **connected with no tools available to this request**. Do not claim the server itself exposes no tools. The reminder must never recommend a name that the current search/dispatch view excludes. The model receives names and short descriptions for discovery; complete parameter schemas remain on-demand through search.

### One reminder budget per boundary

Entry plus all changed-server reminders share `min(floor(usable_input_tokens × 0.1), 20,000)` estimated tokens. The existing unknown-context fallback remains 20,000; an exhausted known window has zero budget. Deduct each emitted part, including a separator allowance, then divide the remaining budget among remaining changed servers.

Count the entire text, including wrappers, status, instructions, diagnostics, and retractions. Connected tools fall back from descriptions to names, then a truncated list with a search hint, then compact status. Diagnostic previews and large retraction lists are bounded. Search-miss diagnostics reuse the same normalization and harness-tag escaping as reminders. If even a compact reminder cannot fit, emit no part and do not mark that outcome as delivered. Search still covers the complete authorized catalog.

### Keep the mechanism and prompts simple

Only report the server's current status, a short diagnostic when useful, and available tool names/descriptions with a search/use pointer. Avoid repeated instructions telling the model what to infer from a failure or how to work around the user's MCP setup. Ordinary ambiguity in invalid or conflicting MCP configuration is outside this amendment; preserve existing registration behavior.

### Verification boundaries

Use the real prompt serialization path with controlled MCP service snapshots to inspect what reaches the test model endpoint. Cover state recurrence, changing error details, disable/removal before and after connection, restored tool sets, request/permission/agent filtering, and a shared multi-server budget. Unit tests cover rendering, tiny/zero budgets, long errors and retractions, fingerprints, and escaped readiness/search output. Prompt tests also cover auto-mode re-evaluation without auxiliary message parts, legacy announcement evidence, and duplicate names within a server. Resume, cold-tool initialization, scheduled prompts, and title tests must not acquire auxiliary MCP bookkeeping parts in their original user messages. The actor guard test must exercise actual Inbox delivery independently of prior test initialization. Existing MCP integration tests protect prefix stability, sticky deferral, dispatch, lifecycle, and result handling. These tests establish context correctness; they do not measure a real model's tool-selection success rate.

## [S3] Out of Scope

- Changing `FIRST_TURN_WAIT` or connection lifecycle.
- Mid-turn ambient push into history.
- Full JSON Schema validation of `mcp_tool_use` arguments.
- Consuming `MCP.ToolsChanged` as a dirty signal.
- Extending readiness reminders to GPT/`exec` or non-deferred tool exposure.
- Empirical evaluation of real-model tool-selection success rates.
- Persisting auxiliary cache-mode state when there is no real MCP reminder or call.
- Repairing user MCP configuration, changing normalized-name registration ownership, or distinguishing all ambiguous cross-server name collisions.

## Tasks

- [x] T4: Compare the latest server state — acceptance: repeated failures and error-detail changes add no reminder; failure/recovery and tool-set recurrence each reach the model (covers: S2)
- [x] T5: Report unavailable and removed servers — acceptance: pending, disabled, and removed transitions invalidate prior tool availability once; pending-server removal is covered; initially disabled servers remain quiet (covers: S2)
- [x] T6: Align advertised tools with request authorization — acceptance: request disables, permissions, and agent allowlists hide the same tools from reminders and search, with matching visible counts (covers: S2)
- [x] T7: Enforce a shared reminder budget — acceptance: multi-server serialized reminders remain within one budget; long diagnostics, retractions, and zero budgets are covered without marking omitted outcomes delivered (covers: S2)
- [x] T9: Remove auxiliary mode persistence — acceptance: auto mode may re-evaluate without real announcement/call evidence; original user messages remain unchanged across resume, cold initialization, scheduled prompts, and title handling (covers: S2)
- [x] T10: Keep diagnostics safe and prompts concise — acceptance: search-miss names/errors use existing escaping and preview bounds; reminders contain status, tools, and a brief search/use pointer (covers: S2)
- [x] T11: Make the actor send guard fixture deterministic — acceptance: the test proves a subagent may send via exec using actual inbox behavior, independent of prior app-runtime initialization (covers: S2)
- [x] T8: Verify and independently review the integrated feature — acceptance: focused MCP suites and typecheck pass, lint introduces no diagnostics, and spec compliance/correctness/codebase consistency have no unresolved critical findings (covers: S2; depends: T4, T5, T6, T7, T9, T10, T11)
