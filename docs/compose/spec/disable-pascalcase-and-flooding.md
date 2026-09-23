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

Also added same-step exact tool-call duplicate cancel (from #2514's content
guard, without its flood quota): first identical (tool name + stable args) call
runs; later same-step repeats are rejected before FIFO admission and do not
fail-cascade distinct suffix calls. While that guard is on (default), the
same-step `doom_loop` ask is skipped so cancelled repeats do not demand a
confirmation. Opt out of either with
`MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT`.

**Verification** — From `packages/opencode`:

- PASS: `bun typecheck`
- PASS: `bun test test/session/toolcall-duplicate.test.ts test/session/tool-fail-cascade.test.ts test/session/invalid-tool-cascade.test.ts test/tool/gate.test.ts test/tool/fail-cascade.test.ts test/session/structured-output.test.ts --timeout 30000` — 89 passed, 0 failed, 608 assertions
- PASS: three consecutive identical writes complete without a doom_loop ask
- Independent review of the removal half previously found no critical findings

**Journey log**

1. Flooding and PascalCase are independent of the FIFO/fail-cascade gate; the
   gate file stayed out of the removal diff.
2. Duplicate cancel rejects before `gate.run`, so it cannot fail-cascade later
   distinct calls.
3. Doom_loop only watches one assistant message for three identical tool parts —
   the same shape duplicate cancel already neutralizes. Coupling the ask to the
   duplicate flag avoids confirming calls that will not run.
4. Historical prefix snapshots may still carry `model_name`; `restoreTools`
   ignores leftover keys (no migration).
5. Same-step exact-signature cancel does not treat a post-edit verification
   `read` as distinct from an earlier identical `read`; put that read in the
   next step if needed.

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

### Add — same-step toolcall duplicate cancel

Keep the content-based duplicate guard from #2514 without its flood quota:

- Per assistant step, an exact repeat of (canonical tool name + stable-stringified
  args) is rejected without executing, with tool return
  `Tool call cancelled because it exactly matches an earlier tool call in this step and was not executed.`
- First occurrence runs. Cross-step and cross-turn repeats stay normal.
- Applies to model-facing builtin tools and model-facing MCP tools. Exec guest
  calls are script-owned and unchanged.
- Duplicate cancel happens before FIFO admission and does **not** fail-cascade
  later distinct calls.
- `MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT=1` or `true` opts out (default on).

### Doom-loop coordination

`doom_loop` only watches one assistant message for three identical tool parts.
That window is the same-step exact-repeat shape the duplicate guard already
neutralizes. While duplicate detect is enabled (the default), skip the
`doom_loop` permission ask so cancelled repeats do not demand a confirmation
for a call that will not run. When `MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT`
is set, restore the existing doom_loop ask. Cross-step nudge / loop-streak /
text-loop stay unchanged.

## [S3] Out of Scope

- Reverting prompt display names back to lowercase labels.
- Changing FIFO / fail-cascade semantics or flags.
- Open PR #2514 flood quota / generation barrier — not merged.
- GPT/Codex tool surfaces, MCP tool names, and the shared exec gateway.
- Database migrations for historical prefix snapshots that stored `model_name`.
- Semantic equivalence for non-identical same-step calls (for example a
  verification `read` after `edit` with the same path).

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
- [x] T4: Add same-step duplicate cancel with doom-loop coordination —
  acceptance: first identical call runs, later same-step exact repeats cancel
  with `TOOLCALL_DUPLICATE_ERROR` and do not fail-cascade distinct suffix calls;
  three consecutive identical calls do not raise `doom_loop` while the guard is
  on; `MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT` restores identical repeats
  (covers: S2; depends: T3).
- [x] T5: Verify — acceptance: package typecheck and focused suites pass
  (covers: S2; depends: T4).
