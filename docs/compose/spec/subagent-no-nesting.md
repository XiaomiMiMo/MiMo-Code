---
feature: subagent-no-nesting
status: designed
updated: 2026-06-18
branch: subagent-no-nesting
commits: <base-sha>..<head-sha>
---

# Subagent nesting off by default

## Report

## [S1] Problem

A `general` subagent can spawn further subagents, with no depth limit.

- `agent.ts` gives `general` `Permission.merge(defaults, user)`, and `defaults` carries `"*": "allow"`; it declares no `toolAllowlist`.
- `Permission.disabled` (permission/index.ts:669) only drops a tool when a matching rule has `pattern === "*"` and `action === "deny"`, so nothing removes `actor` from `general`'s schema.
- `tool/actor.ts` passes `tools: "INHERIT"` for an agent without a `toolAllowlist`, and `prompt.ts:1276` turns `INHERIT` into "no runtime whitelist".
- `Actor.spawn` records only `parentActorID`; there is no depth field and no ancestry check anywhere on the spawn path.
- `prompt/general.txt` actively invites it: "You may delegate genuinely independent, bounded subtasks when that improves throughput".

Verified empirically before the change: `bun dev debug agent general` reports `"actor": true`, `bun dev debug agent explore` reports `"actor": false` (explore only because of its own blanket `"*": "deny"`, not by design).

Consequences: unbounded fan-out of agent trees, cost and concurrency that no single cap governs (`workflow/runtime.ts:34`'s lifecycle cap only bounds `workflow()`'s own `spawnRef` spawns), and a parent that cannot account for work done two levels down.

## [S2] Design

Make one level of delegation the default: a subagent does not see the `actor` tool at all.

**Mechanism.** In `agent.ts`, after the config merge loop and alongside the existing `whitelistedDirs` normalization pass, inject `actor: "deny"` for every agent with `mode === "subagent"`. The rule is merged **before** the agent's accumulated ruleset, so `agent.<name>.permission.actor: "allow"` in user config still wins (`evaluate` uses `findLast`).

```ts
for (const name in agents) {
  if (agents[name].mode !== "subagent") continue
  agents[name].permission = Permission.merge(
    Permission.fromConfig({ actor: "deny" }),
    agents[name].permission,
  )
}
```

Because the rule's pattern is `"*"`, `Permission.disabled` removes `actor` from the subagent's LLM-visible tool schema (`llm.ts` `resolveTools`), which also makes `ctx.ask({ permission: "actor" })` unreachable for that agent. Verified rule semantics:
`disabled(["actor"], merge(defaults, fromConfig({ actor: "deny" })))` → `["actor"]`.

**Scope.** All `mode === "subagent"` agents, native and user-defined, including hidden ones. Hidden internals already lack `actor` through `toolAllowlist` (`title`/`summary`/`compaction` have `[]`; `dream`/`distill` enumerate their tools), so the rule is a no-op for them.

**checkpoint-writer parity.** `checkpoint-writer` is the one hidden subagent with no `toolAllowlist`, because a fork must mirror the parent's tool schema for prefix-cache alignment. Its visibility ruleset is `merge(writer.permission, parentPermission)` (`llm.ts` `resolveTools` via `prompt.ts:3896`), and `parentPermission` is merged last, so the parent primary's `"*": "allow"` out-ranks the injected deny under `findLast`. Parity therefore holds; a test pins this rather than leaving it to inspection.

**Prompt alignment.** `prompt/general.txt` must stop inviting delegation, and must not push the model to look for an absent tool. Replace the delegation bullet with an explicit statement that the assignment is the subagent's own to finish, and that a genuinely out-of-scope piece is reported back to the parent instead of delegated. No other prompt mentions subagent-side delegation; `tool/actor.txt` is only rendered for agents that still hold the tool, so it stays unchanged.

**Behavior after the change.** Peer/orchestrator sessions (`session` tool, already orchestrator-only), `workflow()`'s internal `spawnRef` spawns, and `checkpoint-writer` forks are all untouched — none of them route through the subagent's `actor` tool schema. A subagent loses `actor`'s non-spawn verbs (`status`/`wait`/`cancel`/`send`/`models`) as an accepted cost of full invisibility.

## [S3] Out of Scope

- No depth counter or ancestry check in `Actor.spawn`; the gate is tool visibility only.
- No change to the `session` tool, orchestrator peers, or the workflow runtime's own spawn cap.
- Not fixing the pre-existing permission-name split where `registry.ts:340` filters spawnable types with `evaluate("task", ...)` while `actor.ts:696` asks with `permission: "actor"`.
- No new config key or experimental flag; the existing `agent.<name>.permission.actor` is the opt-back-in.

## Tasks

- [ ] T1: Inject `actor: "deny"` for every `mode === "subagent"` agent in `agent.ts`, merged before the agent's own rules — acceptance: `bun dev debug agent general` reports `"actor": false`, and a config `agent.general.permission.actor: "allow"` restores `true` (covers: S2)
- [ ] T2: Rewrite the delegation bullet in `prompt/general.txt` so it neither invites delegation nor names an absent tool — acceptance: the file no longer contains "You may delegate", and states that the subagent completes or reports back (covers: S2; depends: T1)
- [ ] T3: Add regression tests — every `mode === "subagent"` agent has `actor` disabled, a user `actor: "allow"` override re-enables it, and `checkpoint-writer` under a parent primary's `parentPermission` still sees `actor` — acceptance: new tests fail on `main`'s behavior and pass here (covers: S2; depends: T1)
- [ ] T4: Verify with `bun turbo typecheck`, the agent/actor test files, and a live `bun dev debug agent` for `general` + `explore` — acceptance: recorded commands with PASS/PRE-EXISTING status (covers: S2; depends: T1, T2, T3)
