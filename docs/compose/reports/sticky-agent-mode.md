---
feature: sticky-agent-mode
status: proposed
specs: []
plans: []
branch: feat/sticky-agent-mode
---

# Sticky Agent Mode — Final Report

## What Was Built

An experimental mode-locking system where agent selection is permanent for the duration of a session. Once a session has content (any user message), the user cannot switch to a different mode group. Build and Plan form a single free-switch group; all other agents (Compose, etc.) are isolated — once you're in Compose, you stay in Compose until `/new`.

Three supporting changes enable a clean per-mode experience:

1. **Permission-based skill scoping** — compose skills use `deny`/`allow` permissions instead of `hidden: true`
2. **Plan tools scoped to build/plan** — `plan_enter`/`plan_exit` denied by default, allowed only for build/plan (keeping compose's tool list clean)
3. **Removed `composeSkillsBlock()` injection** — compose skills appear naturally in the system prompt via `available(agent)`

## Architecture

### Sticky Mode (TUI)

**File:** `packages/opencode/src/cli/cmd/tui/context/local.tsx`

- `agentStore.sessionHasMessages` — reactive boolean derived from `!!lastUserMessage()`
- `FREE_SWITCH_GROUP = ["build", "plan"]` — agents that can freely switch between each other
- `canSwitchTo(target)` — returns true if: no messages yet, OR target is self, OR both current and target are in the same group
- `set(name)` — unguarded, for system/programmatic use (session restore, plan tools, CLI)
- `userSwitch(name)` — guarded, for user actions (dialog, voice). Shows contextual toast when blocked
- `move(direction)` — cycles through agents, skipping blocked ones. Toast only when no valid target exists
- `switchBlockedToast()` — shows subset message (build/plan group) or locked message (compose isolated)

**File:** `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`

```ts
createEffect(() => {
  local.agent.setSessionHasMessages(!!lastUserMessage())
})
```

Single reactive effect — no manual lock/unlock. Naturally handles `/new` (empty session = unlocked), `/session` (has messages = locked), and message submission.

### Permission-Based Skill Scoping

**File:** `packages/opencode/src/agent/agent.ts`

- `defaults` includes `skill: { "*": "allow", "compose:*": "deny" }`
- Compose agent overrides with `skill: { "compose:*": "allow" }`

**File:** `packages/opencode/src/skill/index.ts`

- `Skill.available()` no longer filters `!sk.hidden` — relies entirely on permission

### Plan Tools Scoping

**File:** `packages/opencode/src/agent/agent.ts`

- `defaults` includes `plan_enter: "deny"`, `plan_exit: "deny"`
- Build agent: `plan_enter: "allow"`, `plan_exit: "allow"`
- Plan agent: `plan_enter: "allow"`, `plan_exit: "allow"`
- Both agents see BOTH tools (symmetric, no list mutation on build↔plan switch)

**No registry.ts changes needed** — `llm.ts:resolveTools()` already uses `Permission.disabled()` to strip denied tools before sending them to the model. The permission rules in agent.ts are sufficient.

### Compose Prompt Cleanup

**File:** `packages/opencode/src/session/prompt.ts`

- `composeSkillsBlock()` import and call removed
- Only `{{compose_docs_dir}}` substitution remains in PROMPT_COMPOSE

**File:** `packages/opencode/src/session/prompt/compose.txt`

- "Compose Skills Visibility" section simplified: skills are in the normal listing
- Subagent guidance: "distill instructions into prompts"

### Design Decisions

**`set()` vs `userSwitch()` separation:** The guard only applies to user-initiated actions (Tab, dialog, voice). System paths (session restore, plan_enter/plan_exit, CLI --agent) use `set()` directly and are never blocked. This avoids a fragile whitelist of "force" call sites.

**Reactive `sessionHasMessages` from `lastUserMessage()`:** No manual lock/unlock state. The signal is derived from actual session content, so `/new`, `/session`, and submits all work correctly without explicit handling.

**`move()` skips blocked agents:** Tab cycles within the allowed group instead of stopping at the first blocked agent. Toast only shows when the entire group has been exhausted (e.g., compose mode with no other compose-group agents).

**Self-switch always allowed:** `canSwitchTo` returns true when `current === target`. Prevents false toast on no-op switches (e.g., compose user selecting compose in `/agents` dialog).

**Contextual toast messages:** Two variants — "只能在 build, plan 之间切换" when in the group but target is outside, "进入 compose 模式后无法切换" when isolated with no valid targets.

**Plan tools: symmetric allow in build/plan, deny in defaults:** Future agents automatically inherit the deny. Build and plan both see both tools (no list mutation within the group). This is NOT a revert of #1207 — #1207 made plan tools visible to ALL agents; this scopes them to the build/plan group only, possible because sticky mode prevents cross-group switching.

**Permission in defaults (deny) + specific agent override (allow):** Used for both skills (`compose:*`) and tools (`plan_enter`/`plan_exit`). Future agents automatically inherit all deny rules. Only the relevant agent explicitly opts in.

## Usage

- **New session:** Mode selector works normally (Tab cycles all agents)
- **After first message:** Mode is locked to the current group
  - Build/Plan: Tab cycles between them. Toast when trying to reach Compose
  - Compose: Tab shows toast — cannot switch mid-session
- **`/new`:** Creates empty session → mode unlocked again
- **`/session`:** Enters existing session → mode locked to that session's agent
- **Self-switch:** Always allowed (no-op, no toast)

## Verification

- `bun typecheck` — clean
- `bun test test/session/prompt-skill-mention.test.ts` — 8/8 pass
- `bun test test/permission` — 141/141 pass
- `bun test test/agent/agent.test.ts` — 48/48 pass

## Design Notes

Key constraints that shaped the final approach:

- Guard must separate system paths (`set()`) from user actions (`userSwitch()`) — putting the guard directly in `set()` requires a fragile whitelist for session restore, plan tools, and CLI
- Sticky state must be **derived** (`!!lastUserMessage()`), not manually managed — a boolean `lock()` breaks on `/new` and `/session` transitions
- `move()` must skip blocked agents rather than stopping — otherwise Tab appears broken when the next agent in order is blocked
- Plan tools use the existing `Permission.disabled()` pipeline in `llm.ts:resolveTools()` — no registry changes needed
