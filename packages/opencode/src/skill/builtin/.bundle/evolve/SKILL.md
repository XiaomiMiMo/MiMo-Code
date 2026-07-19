---
name: evolve
description: Use when you want to modify ANY aspect of yourself — your capabilities (new/overridden tools), your behavior (hooks that intercept every tool call, LLM request, session and subagent lifecycle), your knowledge (skills that persist across sessions), your orchestration (workflow scripts), or even your UI (TUI panels, commands, dialogs). Nothing about you is fixed: every layer from what tools you expose, to how you react to events, to what the user sees on screen is rewritable through files in .mimocode/. Use proactively — repeated manual sequence 3+ times, repeated user correction, durable project knowledge, or any "I wish I could..." moment is a trigger to evolve.
---

# Evolve — Total Self-Modification

Every layer of you is rewritable by writing files to `.mimocode/` (reload semantics differ per layer — see File Locations):

- **What you can do** — create tools, or override any built-in (bash, read, edit, ...) with your own implementation
- **How you behave** — hooks intercept everything: every tool call (block/rewrite args/rewrite output), every LLM request (system prompt, message list, temperature, headers), every session and subagent lifecycle event (cancel a run before it starts, gate a subagent's delivery and force it to redo work, inspect full trajectories after each step)
- **What you know** — skills persist domain knowledge across sessions
- **How you orchestrate** — workflow scripts encode multi-agent pipelines deterministically
- **What the user sees** — TUI plugins add panels, commands, dialogs, routes to the interface itself

This skill is not documentation — it is a standing instruction to **notice when you should evolve, and act on it**.

## When to evolve (triggers)

Act on these signals — don't wait for the user to ask:

| Signal | Action |
|--------|--------|
| You ran the same bash/API sequence 3+ times (this or past sessions) | Wrap it into a **tool** |
| You keep making the same mistake, or the user keeps correcting the same behavior | Add a **hook** to block/fix it structurally |
| You learned non-obvious project knowledge that future sessions will need | Write a **skill** to persist it |
| A built-in tool's behavior conflicts with project needs | **Override** it (same-name tool) |
| A workflow you hand-orchestrated worked well and may repeat | Save it as a **workflow** script |

Before creating: check whether the extension already exists (`ls .mimocode/tools .mimocode/hooks .mimocode/skills`). Prefer improving an existing one over adding a near-duplicate.

## Decision flow

```
Need to change WHAT you can do  → tool   (new capability, wraps commands/APIs)
Need to change HOW you behave   → hook   (intercept/modify/block existing behavior)
Need to remember HOW to do X    → skill  (knowledge, loaded on demand)
Need to redo a multi-agent run  → workflow (.mimocode/workflows/*.js)
Need to change the UI           → TUI plugin (.mimocode/tui/*.tsx)
```

Rule of thumb: tools add verbs, hooks add reflexes, skills add memories.

## Creating Tools

Write to `.mimocode/tools/<name>.ts`:

```ts
import { tool } from "@mimo-ai/plugin"

export default tool({
  description: "What this tool does",
  args: {
    param1: tool.schema.string().describe("Parameter description"),
  },
  async execute(args, ctx) {
    // ctx.directory — project root
    // ctx.worktree — git worktree root
    // ctx.abort — AbortSignal
    return `Result: ${args.param1}`
  },
})
```

Multiple tools per file: use named exports instead of default.
A tool with the same id as a built-in (bash, read, edit, ...) **replaces** it.

## Creating Hooks

Write to `.mimocode/hooks/<name>.ts` — export a Hooks object:

```ts
export default {
  "tool.execute.before": async (input, output) => {
    if (input.tool === "bash" && output.args.command?.includes("rm -rf /")) {
      output.cancel = true
      output.cancelReason = "Blocked dangerous command"
    }
  },
  "experimental.chat.system.transform": async (input, output) => {
    output.system.push("Additional instruction here.")
  },
}
```

### Hook Events

| Event | Capability |
|-------|-----------|
| `tool.execute.before` | Modify `output.args` or set `output.cancel=true` to block |
| `tool.execute.after` | Modify tool result via `output.output` (string), `output.title`, `output.metadata` — NOT `output.result` |
| `tool.definition` | Modify tool description/parameters |
| `chat.params` | Modify temperature, topP, maxOutputTokens |
| `experimental.chat.system.transform` | Append to system prompt |
| `experimental.chat.messages.transform` | Modify message list sent to LLM |
| `session.pre` / `session.post` | Session runLoop lifecycle; `post` receives the full trajectory |
| `session.userQuery.pre` / `.post` | Per-LLM-step lifecycle; cancel or inspect each step |
| `actor.preStop` / `actor.postStop` | Gate subagent delivery; `continue=true` forces another turn |
| `permission.ask` | Auto-allow/deny permission requests (not yet wired) |
| `shell.env` | Inject environment variables |

Field names must match exactly — a typo'd field (e.g. `output.result`) fails
silently. Always check @reference/hook-api.md for the exact input/output shape
before writing a hook.

## Creating Skills

Write to `.mimocode/skills/<name>/SKILL.md`:

```markdown
---
name: my-skill
description: Use when [triggering conditions — not a workflow summary]
---
Instructions here...
```

## File Locations

| Type | Path | Hot-reload |
|------|------|-----------|
| Tools | `.mimocode/tools/*.ts` | next turn |
| Hooks | `.mimocode/hooks/*.ts` | next turn |
| Skills | `.mimocode/skills/*/SKILL.md` | next turn |
| Workflows | `.mimocode/workflows/*.js` | on invoke |
| TUI | `.mimocode/tui/*.tsx` | restart |

## Evolution loop (do this every time)

1. **Create** the extension (smallest thing that works).
2. **Verify immediately** — invoke the tool / trigger the hook on the next turn. A broken extension is worse than none.
3. **Tell the user** what you created and why, in one sentence.
4. **Iterate or delete** — if it misfires later, fix it or remove it. Don't leave dead extensions; they pollute your own tool list.

## Detailed API Reference

For full type signatures, all available fields, and more examples:

- See @reference/tool-api.md for Tool schema and ToolContext
- See @reference/hook-api.md for all hook events with input/output types
- See @reference/skill-api.md for SKILL.md format and frontmatter fields
- See @reference/tui-api.md for TUI plugin slots, commands, dialogs, and state

## Constraints

- Tools/hooks have same permissions as bash — no privilege escalation
- Cannot modify the permission system
- Tool output truncated at 50KB / 2000 lines
- Prefer small, composable extensions over monolithic ones
- Never create an extension that hides information from the user or bypasses confirmation prompts
