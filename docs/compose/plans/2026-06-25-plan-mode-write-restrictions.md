# Plan Mode Write Restrictions — Hardened Implementation Plan (v2)

> [!NOTE]
> This document may not reflect the current implementation.
> See the final report for up-to-date state:
> [Final Report](../reports/plan-mode-write-restrictions.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plan mode's write restrictions un-bypassable WITHOUT ever removing a tool from the model's schema — deny actual writes at call time, keep every tool present so the tool list never mutates on mode switch (which would invalidate prefix cache and destroy context).

**Architecture:** Add two declarative fields to `Agent.Info`: `hardPermission` (rules re-appended after the user/session merge so they always win) and `subagentToolAllowlist` (read-only toolset forced on any subagent the agent spawns). A single `runtimePermission(agent, sessionPermission)` helper replaces every `Permission.merge(agent.permission, …)` call site. Crucially, plan's hard rules use only `ask` and `deny-with-non-"*"-exception` forms — NEVER a bare `{"*":"deny"}` — because `Permission.disabled()` strips a tool from the schema ONLY when the last-matching rule is exactly `pattern==="*" && action==="deny"`. The persisted-approval bypass (an `always`-approved edit out-ranking plan's `edit:deny`) is closed in the permission `ask` loop (already committed as Task 0).

**Tech Stack:** TypeScript, Effect, Bun test, Zod schema (`Agent.Info`), the existing `Permission` ruleset system.

## Global Constraints

- Run all commands from `packages/opencode` — tests are guarded against running from repo root.
- Typecheck with `bun typecheck` from `packages/opencode`, never `tsc` directly.
- **No tool may be removed from the schema in plan mode.** Forbidden: any plan rule of the form `<tool>: "deny"` or `<tool>: { "*": "deny" }` with no later non-`"*"` allow exception. Reference: PR #1207 made plan_enter/plan_exit "always visible" precisely because permission-based hiding caused tool-list mutation. We must not reintroduce that.
- Verification that a tool stays in the schema = `Permission.disabled([tool], runtimePermission(plan, []))` returns an empty set for that tool.
- `edit` keeps its existing shape `{ "*": "deny", "<plan-file globs>": "allow" }` — the non-`"*"` allow exception keeps the edit tool in the schema while denying writes to non-plan files at call time.
- `bash`, `change_directory`, `workflow` → `"ask"` (stays in schema; interactive prompt at call time; headless agents get DeniedError via the existing `interactive:false` path).
- `task` → NOT restricted (stays `allow`). Plan must be able to spawn subagents (e.g. explore) for research.
- Plan-spawned subagents are forced read-only via `subagentToolAllowlist = READONLY_TOOLS` — research is allowed, delegated writes are not.
- No `agent.name === "plan"` / `ctx.agent === "plan"` string checks in src — the restriction is data on the agent definition. (The actor wiring reads `subagentToolAllowlist` off whatever agent is spawning; no name check.)
- Preserve behavior for non-plan agents (build/compose/general): they have no `hardPermission`, so `runtimePermission` reduces to the old `merge(agent.permission, session)`.

---

## Task 0 (DONE — already committed `83d9b19`): Persisted approval cannot override ruleset deny

`packages/opencode/src/permission/index.ts` ask loop now evaluates the ruleset alone (deny short-circuits) before consulting approvals; approvals only upgrade an `ask` to `allow`. Test added in `test/permission/next.test.ts` (`ask - persisted approval does not override ruleset deny`). This is the genuine root cause of "user edited in plan mode". No further work; listed for context.

---

### Task 1: Agent.Info gains hardPermission + subagentToolAllowlist + runtimePermission helper

**Covers:** Schema + helper foundation for all later tasks

**Files:**
- Modify: `packages/opencode/src/agent/agent.ts` (Info schema ~L39; add module-level constant + helper after the `Service` class ~L74)

**Interfaces:**
- Consumes: `Permission.Ruleset.zod`, `Permission.merge`.
- Produces:
  - `Info.hardPermission?: Permission.Ruleset` — non-overridable rules.
  - `Info.subagentToolAllowlist?: string[]` — forced tool allowlist for spawned subagents.
  - `export const READONLY_TOOLS: string[]` — single source of truth for the read-only toolset.
  - `export function runtimePermission(agent: Info, permission?: Permission.Ruleset): Permission.Ruleset` = `Permission.merge(agent.permission, permission ?? [], agent.hardPermission ?? [])`.

- [ ] **Step 1: Add schema fields.** In the `Info` zod object, after `permission: Permission.Ruleset.zod,`:

```ts
    // Non-overridable rules appended AFTER user/session permissions during
    // runtime evaluation (see runtimePermission). Use for agent invariants that
    // config must not be able to relax — e.g. plan mode's write restrictions.
    hardPermission: Permission.Ruleset.zod.optional(),
    // Tool allowlist forced on any subagent this agent spawns (overrides the
    // spawned agent's own toolAllowlist / INHERIT). Plan mode uses it to keep
    // delegated work read-only.
    subagentToolAllowlist: z.array(z.string()).optional(),
```

- [ ] **Step 2: Add constant + helper** after `export class Service ...`:

```ts
// Tools that cannot mutate the workspace. Source of truth for plan mode's
// subagentToolAllowlist. (Intentionally NOT shared with the explore agent's
// inline list: explore allows read-only `bash` for shell exploration, which a
// plan subagent must not have — they are different contracts that happen to
// overlap.)
export const READONLY_TOOLS = [
  "read",
  "glob",
  "grep",
  "list",
  "webfetch",
  "websearch",
  "codesearch",
  "memory",
  "history",
  "lsp",
]

// Merge an agent's permission with the user/session ruleset, then re-append the
// agent's hardPermission so those invariants win over any allow rule a user or
// session approval could introduce. Every permission-evaluation site routes
// through this — there is no per-agent name special-casing.
export function runtimePermission(agent: Info, permission?: Permission.Ruleset) {
  return Permission.merge(agent.permission, permission ?? [], agent.hardPermission ?? [])
}
```

- [ ] **Step 3: Typecheck** — `bun typecheck`. Expected: clean (fields optional, helper self-contained).

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/agent/agent.ts
git commit -m "$(cat <<'EOF'
feat(agent): add hardPermission, subagentToolAllowlist, runtimePermission

Co-authored-by: MiMo-Code <noreply@mimo.xiaomi.com>
EOF
)"
```

---

### Task 2: Plan write restrictions as hardPermission — NO tool removed from schema

**Covers:** Bypass paths "bash writes workspace files", "change_directory", "workflow"; keeps `task`/explore usable

**Files:**
- Modify: `packages/opencode/src/agent/agent.ts` (plan agent block ~L181)
- Modify: `packages/opencode/test/agent/agent.test.ts` (existing plan test now reads via runtimePermission; add new assertions)

**Interfaces:**
- Consumes: `Permission.fromConfig`, `Global.Path.data`, `Instance.worktree`, `READONLY_TOOLS`, `runtimePermission`, `Permission.disabled`, `Permission.evaluate`.
- Produces: plan `Info` with `hardPermission` (edit deny+plan-file allow exceptions; bash/change_directory/workflow → ask; external_directory plan-dir allow) and `subagentToolAllowlist = READONLY_TOOLS`. `task` is intentionally absent → stays `allow`.

- [ ] **Step 1: Rewrite the plan agent block.** The `permission` field keeps only `defaults` + `question:allow` + `user`. Move write rules into `hardPermission`, using ONLY ask / deny-with-exception (no bare `"*":"deny"`):

```ts
plan: {
  name: "plan",
  color: "#c7e2a8",
  description: "Plan mode. Disallows all edit tools.",
  options: {},
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({ question: "allow" }),
    user,
  ),
  // Invariants user/session config must not relax. Re-appended after the
  // user merge by runtimePermission. CRITICAL: every rule here must keep its
  // tool IN the schema — use "ask" or a deny WITH a non-"*" allow exception.
  // A bare {"*":"deny"} would strip the tool (Permission.disabled) and mutate
  // the tool list on mode switch, breaking prefix cache (see PR #1207).
  hardPermission: Permission.fromConfig({
    plan_exit: "allow",
    bash: "ask",
    change_directory: "ask",
    workflow: "ask",
    external_directory: {
      [path.join(Global.Path.data, "plans", "*")]: "allow",
    },
    edit: {
      "*": "deny",
      [path.join(".mimocode", "plans", "*.md")]: "allow",
      [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
    },
  }),
  subagentToolAllowlist: READONLY_TOOLS,
  mode: "primary",
  native: true,
},
```

- [ ] **Step 2: Update the existing plan test + add new ones.** In `test/agent/agent.test.ts`, replace the existing `test("plan agent denies edits except .mimocode/plans/*", ...)` (it reads `plan!.permission` directly; edit rules now live on `hardPermission`) with this block:

```ts
test("plan denies edits except plan files (via runtimePermission)", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      const rt = Agent.runtimePermission(plan!, [])
      expect(Permission.evaluate("edit", "*", rt).action).toBe("deny")
      expect(Permission.evaluate("edit", ".mimocode/plans/foo.md", rt).action).toBe("allow")
    },
  })
})

test("plan keeps every tool in the schema — no tool removed", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      const rt = Agent.runtimePermission(plan!, [])
      // edit/bash/task/change_directory/workflow must all stay visible.
      expect(
        Permission.disabled(["edit", "write", "bash", "task", "change_directory", "workflow"], rt),
      ).toEqual(new Set())
    },
  })
})

test("plan: bash/change_directory/workflow are ask, task stays allow", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      const rt = Agent.runtimePermission(plan!, [])
      expect(Permission.evaluate("bash", "echo x > f", rt).action).toBe("ask")
      expect(Permission.evaluate("change_directory", "/tmp", rt).action).toBe("ask")
      expect(Permission.evaluate("workflow", "*", rt).action).toBe("ask")
      expect(Permission.evaluate("task", "*", rt).action).toBe("allow")
      expect(plan!.subagentToolAllowlist).toEqual(Agent.READONLY_TOOLS)
    },
  })
})

test("plan hardPermission wins over session/config allow", async () => {
  await using tmp = await tmpdir({ config: { permission: { bash: "allow", edit: "allow" } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await load(tmp.path, (svc) => svc.get("plan"))
      const rt = Agent.runtimePermission(plan!, [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "*", action: "allow" },
      ])
      expect(Permission.evaluate("edit", "src/file.ts", rt).action).toBe("deny")
      expect(Permission.evaluate("bash", "echo x > f", rt).action).toBe("ask")
      // even with config allow, edit tool stays in schema and write still denied
      expect(Permission.disabled(["edit", "bash"], rt)).toEqual(new Set())
    },
  })
})

test("build agent unaffected — no hardPermission", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await load(tmp.path, (svc) => svc.get("build"))
      expect(build!.hardPermission).toBeUndefined()
      const rt = Agent.runtimePermission(build!, [])
      expect(Permission.evaluate("bash", "echo x", rt).action).not.toBe("deny")
    },
  })
})
```

Note: the existing `test("plan_enter and plan_exit ... for all primary agents")` (reads `agent.permission` via `Permission.disabled`) still passes — plan_exit:allow is on hardPermission but disabled() only strips on `"*"+deny`, so its absence from `.permission` does not hide it.

- [ ] **Step 3: Run the tests** — `bun test test/agent/agent.test.ts --timeout 30000`. Expected: PASS. The "no tool removed" + "hardPermission wins" tests call `runtimePermission` directly, so they pass before Task 3 wiring.

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/agent/agent.ts packages/opencode/test/agent/agent.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): plan write restrictions via hardPermission without hiding tools

bash/change_directory/workflow become ask (stay in schema); edit keeps its
plan-file allow exception; task stays allow so plan can spawn research
subagents. No bare "*":"deny", so the tool list never mutates on mode switch.

Co-authored-by: MiMo-Code <noreply@mimo.xiaomi.com>
EOF
)"
```

---

### Task 3: Route every permission merge through runtimePermission

**Covers:** Applies hardPermission at all five evaluation sites (tool-schema filtering, main tool ask, subtask ask, preapproval, debug)

**Files:**
- Modify: `packages/opencode/src/session/llm.ts:477` and `:720`
- Modify: `packages/opencode/src/session/prompt.ts:677` and `:1018`
- Modify: `packages/opencode/src/cli/cmd/debug/agent.ts:171`

**Interfaces:**
- Consumes: `Agent.runtimePermission(agent, sessionPermission?)` from Task 1.

- [ ] **Step 1: llm.ts** — switch `import type { Agent }` to value import `import { Agent } from "@/agent/agent"`. Replace L477:

```ts
const ruleset = Agent.runtimePermission(input.agent, input.permission)
```

and inside `resolveTools` (~L720):

```ts
const disabled = Permission.disabled(
  Object.keys(input.tools),
  Agent.runtimePermission(input.agent, input.permission),
)
```

- [ ] **Step 2: prompt.ts** — `Agent` already imported as value (confirmed at prompt.ts:10). L677:

```ts
ruleset: Agent.runtimePermission(input.agent, input.session.permission),
```

L1018:

```ts
ruleset: Agent.runtimePermission(taskAgent, session.permission),
```

- [ ] **Step 3: debug/agent.ts** — L171:

```ts
const ruleset = Agent.runtimePermission(agent, session.permission)
```

- [ ] **Step 4: Typecheck** — `bun typecheck`. Expected: clean. Fix any `import type` → value-import issue.

- [ ] **Step 5: Run tests** — `bun test test/agent/agent.test.ts test/permission/next.test.ts --timeout 30000`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/session/llm.ts packages/opencode/src/session/prompt.ts packages/opencode/src/cli/cmd/debug/agent.ts
git commit -m "$(cat <<'EOF'
refactor(session): route permission merges through Agent.runtimePermission

Co-authored-by: MiMo-Code <noreply@mimo.xiaomi.com>
EOF
)"
```

---

### Task 4: Plan-spawned subagents inherit the read-only allowlist from agent data

**Covers:** Bypass path "delegate writes to a subagent" — without a name check, and without blocking explore/research

**Files:**
- Modify: `packages/opencode/src/tool/actor.ts` (spawn `tools:` resolution ~L709)
- Modify: `packages/opencode/test/tool/actor.test.ts`

**Interfaces:**
- Consumes: `Agent.Service` (already resolved as `const agent = yield* Agent.Service` at actor.ts:268), `ctx.agent` (spawning agent name), `Info.subagentToolAllowlist`.
- Produces: spawn `tools` = spawning agent's `subagentToolAllowlist` if set, else spawned agent's `toolAllowlist`, else `"INHERIT"`.

- [ ] **Step 1: Resolve the spawning agent's allowlist** before the `actor.spawn({…})` call (~L702):

```ts
const parentAgent = ctx.agent ? yield* agent.get(ctx.agent) : undefined
const forcedSubagentTools = parentAgent?.subagentToolAllowlist
```

- [ ] **Step 2: Use it in the spawn `tools` field** (~L709), replacing the existing line:

```ts
tools: forcedSubagentTools
  ? [...forcedSubagentTools]
  : next.toolAllowlist
    ? [...next.toolAllowlist]
    : "INHERIT",
```

- [ ] **Step 3: Add the test** in `test/tool/actor.test.ts`, inside `describe("tool.actor", …)`. (Confirm `import { Agent } from "../../src/agent/agent"` is present; add if missing.)

```ts
it.live("plan agent spawns subagents with the read-only allowlist", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const spawns: SpawnInput[] = []
      yield* installMockSpawn((input) => spawns.push(input))
      const { chat, assistant } = yield* seed()
      const tool = yield* ActorTool
      const def = yield* tool.init()
      yield* def.execute(
        {
          operation: {
            action: "run",
            description: "research",
            prompt: "investigate without changing files",
            subagent_type: "explore",
          },
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "plan",
          abort: new AbortController().signal,
          extra: {},
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(spawns[0]?.tools).toEqual(Agent.READONLY_TOOLS)
    }),
  ),
)
```

- [ ] **Step 4: Run the test** — `bun test test/tool/actor.test.ts --timeout 30000`. Expected: PASS. If the `subagent_type: "explore"` enum is rejected by validation, fall back to `"general"` (the assertion is about the forced allowlist, not the agent type).

- [ ] **Step 5: Typecheck** — `bun typecheck`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/tool/actor.ts packages/opencode/test/tool/actor.test.ts
git commit -m "$(cat <<'EOF'
feat(actor): plan subagents inherit read-only allowlist from agent data

Plan can still spawn explore/general for research, but the spawned subagent
is constrained to READONLY_TOOLS so writes can't be delegated. Driven by the
spawning agent's subagentToolAllowlist field — no agent-name check.

Co-authored-by: MiMo-Code <noreply@mimo.xiaomi.com>
EOF
)"
```

---

### Task 5: Full verification sweep

**Covers:** Final gate

**Files:** none (verification only)

- [ ] **Step 1: Relevant test run** — `bun test test/agent/agent.test.ts test/permission/next.test.ts test/tool/actor.test.ts --timeout 30000`. Expected: all PASS.

- [ ] **Step 2: Typecheck** — `bun typecheck`. Expected: clean.

- [ ] **Step 3: No-tool-removed audit** — confirm no plan rule strips a tool: re-read the `hardPermission` block; assert every entry is `allow`, `ask`, or a deny carrying a non-`"*"` allow exception. The `test("plan keeps every tool in the schema")` from Task 2 is the automated guard.

- [ ] **Step 4: No name-check audit** — grep `agent.name === "plan"` and `ctx.agent === "plan"` in `src/` → expect zero matches.

- [ ] **Step 5: Diff hygiene** — `git diff --check` (no whitespace errors).

---

## Why this is better than PR #1301

PR #1301 sets `bash/task/workflow/change_directory: "deny"` (bare `"*":"deny"`). That has two real defects:

1. **Tool-list mutation / prefix-cache invalidation.** A bare `"*":"deny"` makes `Permission.disabled()` strip the tool from the model's schema. Switching into plan mode then removes bash/task/workflow/change_directory from the tool list mid-conversation — exactly the instability PR #1207 fixed for plan_enter/plan_exit. This plan keeps every tool present (ask / deny-with-exception only).
2. **Plan can't do research.** `task: "deny"` blocks spawning explore/general subagents. This plan keeps `task` allowed and instead forces spawned subagents read-only via `subagentToolAllowlist`, so plan-mode research works while delegated writes are blocked.

Plus the shared improvements: data-driven `hardPermission` (no `=== "plan"` string checks), single `runtimePermission` helper at every site, and the genuine root-cause fix (persisted approval no longer overrides deny, Task 0).
