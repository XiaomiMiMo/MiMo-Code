---
feature: actor-drop-context
status: delivered
updated: 2026-09-14
branch: feat/actor-drop-context
commits: bceb411c..655fa209
---

# Actor tool: drop model-facing context

## Report

**What was built** — Model-facing `actor spawn`/`run` no longer accept any `context` argument. The JSON schema is a strict object without that field; the shell parser rejects `--context` after the three positionals with a teachable system-only error; execute always calls `Actor.spawn` with `context: "none"`. Tool descriptions no longer advertise conversation/fork inheritance. System/runtime callers that already pass `forkContext` (checkpoint-writer, session peer) are unchanged.

**Verification** — `bun typecheck` (packages/cli) PASS; `bun test` actor.shell + checkpoint-tool-description + actor + actor-recover PASS (76); `bun test` actor/spawn + actor-subagent-gating + actor-spawn-preference PASS (37 pass, 1 skip live-router). Independent review: T1/T2 met, no critical findings; few-shot examples restored after review note.

**Journey log** — ① Root of desktop “spawn 秒退” was `context:"full"` registering a fork agent without `ForkContext`; ② Models must not create forks — only system callers keep that path; ③ Shell reject-after-positionals mirrors `--actor` so quoted positionals are not misread; ④ `recoverActorArgs` drops top-level `context` (safe none) while envelope `context` is schema-rejected; ⑤ Do not delete unrelated few-shot examples when rewriting tool copy.

## [S1] Problem

Model-facing `actor spawn`/`run` advertised `context: none|state|full`. `context:"full"` registers the child as a fork agent, but `tool/actor.ts` never passes `ForkContext`, so the child turn dies with empty `MessageAbortedError` ("秒退") while gate/postStop still fire. Models must not create forks.

## [S2] Design

- Model-facing actor tool supports only standard `spawn`/`run` (plus status/wait/cancel/send/models). No `context` field on JSON schema or shell parser.
- `z.strictObject` rejects any `context` key on spawn/run operations.
- Shell parser rejects `--context` / `--context=` after the three positionals with a teachable flag error (system-only message).
- Execute always calls `Actor.spawn` with `context: "none"`. No checkpoint-summary injection from the tool path.
- System/runtime callers that already pass `forkContext` (checkpoint-writer, session peer) are unchanged.
- Tool copy (`actor.txt`, `actor.checkpoint.txt`) no longer teaches a model-facing context/fork parameter.

## [S3] Out of Scope

- Runtime `Actor.spawn({context, forkContext})` API stays for system callers.
- Desktop UI/prompt snapshot updates (separate desktop pin follow-up).
- Changing `contextMode` registry semantics or fork runLoop itself.

## Tasks
- [x] T1: Remove `context` from actor tool schema, shell parser, execute path, and tool descriptions — acceptance: spawn/run schema rejects `context`; shell rejects `--context`; execute always uses `context:"none"`; descriptions omit model-facing context (covers: S2)
- [x] T2: Update/add unit tests — acceptance: shell rejects `--context`; schema rejects `context`; description tests do not require `context="state"`; actor/spawn system tests still pass (covers: S2; depends: T1)
