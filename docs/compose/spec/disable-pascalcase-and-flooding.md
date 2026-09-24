---
feature: disable-pascalcase-and-flooding
status: delivered
updated: 2026-09-22
branch: codex/disable-pascalcase-and-flooding
commits: 1579e7d9..HEAD
---

# Disable PascalCase Tool Projection and Toolcall Flooding

## Report

**What was built** — Removed the MiMo v2.6 PascalCase tool-name projection at
the model boundary and the entire toolcall-flooding detector. Canonical lowercase
tool IDs are advertised and replayed again; prompt display names (`Edit`,
`Grep`, `Glob`, …) remain unchanged. The FIFO safe-serial gate and fail-cascade
guard stay intact.

**Verification** — From `packages/opencode`:

- PASS: `bun typecheck`
- PASS: `bun test test/session/tool-fail-cascade.test.ts test/session/invalid-tool-cascade.test.ts test/tool/gate.test.ts test/tool/fail-cascade.test.ts test/session/structured-output.test.ts --timeout 30000`
- Independent review previously found no critical findings

**Journey log**

1. Flooding and PascalCase are independent of the FIFO/fail-cascade gate; the
   gate file stayed out of the removal diff.
2. Historical prefix snapshots may still carry `model_name`; `restoreTools`
   ignores leftover keys (no migration).

## [S1] Problem

Two recent engine behaviors need a clean removal while keeping their surrounding
safety work:

1. MiMo v2.6 message-side tool names are projected to PascalCase (`Read`, `Grep`,
   `Edit`, …) at the model boundary (#2490). Prompt text already uses those
   display names and must stay that way, but the request/history casing rewrite
   should be removed cleanly so the harness again advertises canonical lowercase
   tool IDs.
2. Tool-call flooding detection (#2463 / #2487) buffers and cancels oversized
   batches. The whole flooding path should be removed, while the independent
   safe-serial FIFO gate (#2456) and fail-cascade guard stay intact.

## [S2] Design

### Keep

- Prompt and tool-description display labels (`Edit`, `Grep`, `Glob`, `Read`, …)
  introduced for human-facing instructions remain unchanged.
- `packages/opencode/src/tool/gate.ts` FIFO admission (read/grep/glob overlap;
  every other top-level tool serial within an assistant step).
- Fail cascade in the same gate: `FailCascadeError`,
  `FAIL_CASCADE_MESSAGE`, `MIMOCODE_DISABLE_FAIL_CASCADE`, and all
  fail-cascade / gate tests and behavior.
- Provider-native buffering (for example the OpenAI-compatible complete-call
  delay until EOF) is untouched.

### Remove — PascalCase model-boundary projection

Delete the mimo-v2.6 casing rewrite end to end so schema and history names stay
canonical:

- Delete `packages/opencode/src/tool/names.ts` (`usesPascalCaseTools`,
  `defaultToolName`, `toolSurface`, `NamedTool`).
- Drop `modelName` from tool definitions and the `MIMOCODE_PASCAL_CASE_TOOLS`
  flag.
- Stop projecting tools/messages in `session/llm.ts`; restore/prefix rewrite
  branches that only exist for projected names go away.
- Drop `modelName` / `model_name` plumbing from `tool/tool.ts`,
  `tool/registry.ts`, `session/prompt.ts`, `session/llm-request-prefix.ts`,
  `session/prefix-snapshot.ts`, and `session/session.sql.ts`.
- Delete PascalCase tests and flag tests.

Internal execution, permissions, events, and persisted tool IDs were already
canonical and need no behavioral change.

### Remove — toolcall flooding

Delete the flooding detector completely:

- Delete `packages/opencode/src/session/toolcall-flooding.ts`
  (middleware, `guardToolCallStream`, `ToolCallFloodingError`,
  `TOOLCALL_FLOODING_*`).
- Remove middleware wiring and flooding name-restore from `session/llm.ts`.
- Remove flooding recovery (cancelled batch parts, recovery reminder,
  `releasedCallID` skip) and related `retrySafe` special cases from
  `session/processor.ts`.
- Delete `MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT`.
- Delete flooding tests; strip flooding flag combinations from fail-cascade,
  invalid-tool-cascade, structured-output, and tool-safety-flag tests.

### Interaction contract

- Fail cascade and FIFO serial remain independent of both removals.
- A non-read/search tool failure still cancels the rest of the batch via the
  gate; no flooding path reintroduces a generation barrier or early abort.
- Invalid-tool handling and `ToolCompat` name repair stay as they are.
- `doom_loop` keeps its existing three-identical-calls ask.

## [S3] Out of Scope

- Reverting prompt display names back to lowercase labels.
- Changing FIFO / fail-cascade semantics or flags.
- Open PR #2514 flood quota / generation barrier — not merged.
- GPT/Codex tool surfaces, MCP tool names, and the shared exec gateway.
- Database migrations for historical prefix snapshots that stored `model_name`.

## Tasks

- [x] T1: Remove PascalCase projection — acceptance: MiMo v2.6 requests advertise
  lowercase canonical tools and history replays the same names; no
  `MIMOCODE_PASCAL_CASE_TOOLS` / `modelName` remains; prompt display names still
  say Edit/Grep/Glob (covers: S2).
- [x] T2: Remove toolcall flooding — acceptance: no flooding module, middleware,
  recovery reminder, or flag remains; tools execute without a flooding generation
  barrier (covers: S2).
- [x] T3: Preserve safe serial and fail cascade — acceptance: gate FIFO and
  fail-cascade tests still pass unchanged in behavior; flood-related test cases
  are gone (covers: S2; depends: T1, T2).
- [x] T4: Verify — acceptance: package typecheck and focused suites pass
  (covers: S2; depends: T3).
