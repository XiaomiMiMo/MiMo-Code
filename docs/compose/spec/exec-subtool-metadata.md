---
feature: exec-subtool-metadata
status: delivered
updated: 2026-08-24
branch: codex/exec-subtool-metadata
commits: 84f17b64233ae6bd4b65bb8ccd6325fb8a2cdf16..bc1abe91dc7334d709a7ab454269f58d50954b8f
---

# Exec Sub-tool Metadata

## Report

**What was built** — `exec` nested-tool progress now uses a 150 ms trailing-edge debounce while preserving the first admitted call's immediate running snapshot. Every outer terminal path cancels pending progress, terminalizes any nested calls still running, publishes the final complete `sub_parts` snapshot, and waits for the metadata write. Late nested completions cannot overwrite or republish stale terminal state. Existing result and attachment size limits remain unchanged.

**Verification** — `bun test test/tool/tool-script.test.ts test/session/messages-default-main.test.ts` (64 pass, 0 fail); `bun typecheck` (PASS); `git diff --check` (PASS). Independent review of the complete diff and affected-area fixes (PASS; no critical findings).

**Journey log** — The initial implementation was a fixed-window coalescer; review identified that true trailing-edge debounce requires resetting the timer on every update. Review also exposed detached nested promises that could leave persisted snapshots stuck in `running`; terminalization and a closed progress channel now make the terminal state deterministic. No new DB schema or size policy was introduced.

## [S1] Problem

`exec` runs multiple tools inside a sandbox, but the nested tool metadata is currently discarded. The outer tool only keeps aggregate counts and a bounded trace, so a caller cannot reconstruct a nested tool result as if it had been invoked directly. In particular, `actor.spawn` publishes its `{ sessionId, actorId }` through the nested context; `exec` swallows that callback, leaving TUI/Desktop without a reliable clickable subagent reference during execution.

The outer `ToolPart` is persisted by the existing `part.data` JSON column in SQLite. The loss happens before persistence, in `tool-script.ts`, so a new database table is not required for the core fix.

The Desktop MR !3727 (`mimo-desktop` merge `82c4ddf7a`, implementation `63ae744e5`) only standardized exec summaries and script/XML rendering. Its own design document records the nested-actor gap. Desktop currently receives raw engine messages from its message API; once nested metadata is present in the engine part, Desktop can project it into its live/history/shared schemas without a second source of truth.

## [S2] Design

For every nested call, `exec` maintains one ordered, replayable record in outer `state.metadata.sub_parts`. The record is a ToolPart-compatible snapshot with only the outer identity fields omitted (`id`, `sessionID`, `messageID` are not real persisted parts):

```ts
type ExecSubPartSnapshot = {
  seq: number
  type: "tool"
  callID: string
  tool: string
  state: {
    status: "running" | "completed" | "error"
    input: Record<string, unknown>
    title?: string
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    time: { start: number; end?: number }
    attachments?: unknown[]
  }
}
```

The envelope is versioned as `metadata.exec_schema: 1`. `viewExecSubtools(metadata)` is a pure view function: it validates the version and entries, drops malformed records, preserves invocation order, and returns the nested tool view list. It performs no storage writes, no network calls, and never evaluates the original script. Desktop and TUI can use this list to render ordinary tool rows, with an additional outer `exec` fold.

The first admitted nested call publishes an initial snapshot immediately with `status: "running"`; later admissions and metadata callbacks update only their records through the coalesced progress path. A completed or failed call replaces its state with the same fields a direct tool part would expose. Calls not yet admitted do not appear. Terminal success, budget, timeout, cancellation, and error returns all republish the complete array, so `SessionProcessor.completeToolCall` replacing the part metadata cannot erase it.

Live progress publication is trailing-edge debounced (100–200 ms target window) so repeated nested metadata callbacks coalesce to the newest snapshot. The outer `exec` terminal path cancels any pending timer, publishes the latest complete snapshot immediately, waits for that write, and then returns terminal metadata. Nested completion events do not each force a full-array write; only the outer terminal flush is unconditional.

If the outer script terminates before an admitted nested promise settles, the terminal flush converts remaining `running` snapshots to terminal errors and closes the progress channel. Late host completions cannot publish stale updates into the already terminal outer part.

`sub_parts` is JSON-safe by contract because it is stored inside the existing `ToolState.metadata` record and therefore inside `PartTable.data`. No migration or new table is added. Existing consumers that only understand `counts`/`recent` remain compatible. Consumers that need full details can read the raw message part and pass `state.metadata` to `viewExecSubtools`; malformed or absent records degrade to the existing summary.

The TUI `exec` block exposes nested records in its expanded view. Any nested `actor` record with a valid target (`sessionId` + `actorId` from metadata, or an actor target in its input) is rendered as a clickable subagent entry, regardless of whether the action is `spawn`, `run`, `wait`, `status`, or `send`. Desktop can implement the same projection in live/history/share-history by forwarding `exec_schema` and `sub_parts` through its existing tool-step schema; actor notifications remain the authoritative terminal lifecycle event and must not be duplicated.

## [S3] Out of Scope

- A separate SQLite table or query API for nested calls; the canonical storage remains `PartTable.data`.
- Reworking Desktop MR !3727 itself; this branch records the engine contract and the evidence that its requested full-information path is feasible.
- Persisting arbitrary binary attachments across the sandbox boundary; existing attachment behavior is unchanged.
- Changing the model-visible `exec` result envelope or the existing `counts`/`recent` summary fields.

## Tasks

- [x] T1: Define and collect versioned ToolPart-compatible `sub_parts`, including progressive callbacks and actor references — acceptance: every admitted nested call appears once with direct-call input/output/metadata/status/time fields, and a running snapshot is published through the coalesced progress path before it settles (covers: S2)
- [x] T2: Republish `sub_parts` on every terminal exec path and verify it survives outer tool-part completion/persistence — acceptance: terminal metadata cancels pending progress, flushes the latest snapshot immediately, retains all snapshots, and an SQLite-backed part round-trip returns the same envelope (covers: S2; depends: T1)
- [x] T3: Implement the pure `viewExecSubtools` projection and render valid nested actor records as clickable TUI subagent entries — acceptance: the view function returns only valid current snapshots in sequence order; actor rows with any supported action navigate to the actor route; non-actor/invalid rows remain safe summaries (covers: S2; depends: T1)
- [x] T4: Add regression coverage and document the Desktop MR !3727 data contract — acceptance: tool, view, persistence, and TUI tests cover partial live snapshots, complete fields, actor refs, terminal replacement, and fallback behavior (covers: S2)
