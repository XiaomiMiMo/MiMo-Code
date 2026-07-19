# Hook API Reference

## File Format

```ts
import type { Hooks } from "@mimo-ai/plugin"

const hooks: Hooks = {
  "event.name": async (input, output) => {
    // Mutate `output` to modify behavior
  },
}

export default hooks
```

Each file exports a single Hooks object. Multiple events can be handled in one file.

## Event Reference

Quick index (details below):

| Category | Events |
|----------|--------|
| Tool | `tool.execute.before` · `tool.execute.after` · `tool.definition` |
| LLM request | `chat.params` · `chat.headers` · `experimental.chat.system.transform` · `experimental.chat.messages.transform` |
| Message | `chat.message` · `experimental.text.complete` |
| Session lifecycle | `session.pre` · `session.post` · `session.userQuery.pre` · `session.userQuery.post` |
| Actor lifecycle | `actor.preStop` · `actor.postStop` |
| Compaction | `experimental.session.compacting` · `experimental.compaction.autocontinue` |
| Environment | `shell.env` · `command.execute.before` · `permission.ask` (not yet wired) |

### tool.execute.before

Fires before any tool executes. Can modify args or cancel.

```ts
"tool.execute.before": async (input, output) => {
  // input (read-only):
  //   input.tool: string      — tool id ("bash", "write", "edit", etc.)
  //   input.sessionID: string
  //   input.callID: string

  // output (mutable):
  //   output.args: any        — tool arguments, mutate to change
  //   output.cancel?: boolean — set true to block execution
  //   output.cancelReason?: string — shown to LLM as tool result
}
```

### tool.execute.after

Fires after tool execution. Can modify the result.

```ts
"tool.execute.after": async (input, output) => {
  // input (read-only):
  //   input.tool: string
  //   input.sessionID: string
  //   input.callID: string
  //   input.args: any         — the args that were used

  // output (mutable):
  //   output.title: string
  //   output.output: string   — the tool's text output
  //   output.metadata: any
}
```

### tool.definition

Modify tool descriptions/parameters sent to LLM.

```ts
"tool.definition": async (input, output) => {
  // input.toolID: string

  // output (mutable):
  //   output.description: string  — tool description
  //   output.parameters: any      — JSON Schema for parameters
}
```

### chat.params

Modify LLM request parameters.

```ts
"chat.params": async (input, output) => {
  // input (read-only):
  //   input.sessionID: string
  //   input.agent: string
  //   input.model: Model
  //   input.provider: ProviderContext

  // output (mutable):
  //   output.temperature: number
  //   output.topP: number
  //   output.topK: number
  //   output.maxOutputTokens: number | undefined
  //   output.options: Record<string, any>
}
```

### chat.headers

Add custom HTTP headers to LLM requests.

```ts
"chat.headers": async (input, output) => {
  // input: same as chat.params
  // output.headers: Record<string, string>  — mutate to add headers
}
```

### experimental.chat.system.transform

Modify the system prompt sent to LLM.

```ts
"experimental.chat.system.transform": async (input, output) => {
  // input.sessionID?: string
  // input.model: Model

  // output.system: string[]  — array of system prompt sections
  // Push to append, splice to insert, replace to override
  output.system.push("Always respond concisely.")
}
```

### experimental.chat.messages.transform

Modify the message list sent to LLM.

```ts
"experimental.chat.messages.transform": async (input, output) => {
  // output.messages: Array<{ info: Message, parts: Part[] }>
  // Filter, reorder, or modify messages before they reach the model
}
```

### permission.ask

Auto-allow or deny permission requests.

> **Note:** Defined in the Hooks interface but not yet wired in the permission system. Writing this hook is safe (no-op until upstream integrates it).

```ts
"permission.ask": async (input, output) => {
  // input: Permission object (permission name, patterns, metadata)
  // output.status: "ask" | "deny" | "allow"
  
  // Example: auto-allow all read operations
  if (input.permission === "read") {
    output.status = "allow"
  }
}
```

### shell.env

Inject environment variables into shell execution.

```ts
"shell.env": async (input, output) => {
  // input.cwd: string
  // input.sessionID?: string
  // output.env: Record<string, string>
  
  output.env.NODE_ENV = "development"
  output.env.DEBUG = "true"
}
```

### command.execute.before

Inject content before a slash command runs.

```ts
"command.execute.before": async (input, output) => {
  // input.command: string
  // input.sessionID: string
  // input.arguments: string
  // output.parts: Part[]  — prepend parts to the command
}
```

### experimental.session.compacting

Customize the compaction prompt.

```ts
"experimental.session.compacting": async (input, output) => {
  // input.sessionID: string
  // output.context: string[]  — additional context for compaction prompt
  // output.prompt?: string    — if set, replaces default compaction prompt entirely
}
```

### chat.message

Called when a new message is received.

```ts
"chat.message": async (input, output) => {
  // input.sessionID: string
  // input.agent?: string
  // input.model?: { providerID, modelID }
  // output.message: UserMessage
  // output.parts: Part[]
}
```

### experimental.compaction.autocontinue

Control whether a synthetic "continue" user turn is added after compaction succeeds.

```ts
"experimental.compaction.autocontinue": async (input, output) => {
  // input.sessionID: string
  // input.agent: string
  // input.overflow: boolean   — true when compaction was forced by context overflow
  // output.enabled: boolean   — default true; set false to skip the auto-continue turn
}
```

### session.pre / session.post

Session runLoop lifecycle. `session.pre` fires once before the first LLM step (set `output.cancel = true` to abort without calling the model). `session.post` fires once when the loop ends — guaranteed even on errors/interruptions.

```ts
"session.pre": async (input, output) => {
  // input.sessionID, input.agentID, input.task_id?
  // output.cancel?: boolean, output.cancelReason?: string
},
"session.post": async (input, output) => {
  // input.outcome: "completed" | "error" | "cancelled"
  // input.error?: string
  // input.finalText?: string
  // input.trajectory: TrajectoryMessage[]  — full raw agent slice (user text,
  //   tool calls/results, reasoning) — the hook for post-run analysis/persistence
}
```

### session.userQuery.pre / session.userQuery.post

Per-LLM-step lifecycle (a single user turn spans several steps: tool round-trips, retries). `pre` can cancel the step; `post` is guaranteed to fire even on step failure, with `trajectory` through this step.

```ts
"session.userQuery.pre": async (input, output) => {
  // input.step: number, input.messageID, input.query
  // output.cancel?: boolean, output.cancelReason?: string
},
"session.userQuery.post": async (input, output) => {
  // input.step, input.assistantMessageID, input.finish?, input.error?
  // input.finalText?: string, input.trajectory: TrajectoryMessage[]
}
```

### actor.preStop / actor.postStop

Actor (subagent/peer) delivery lifecycle. `preStop` fires before finalText is delivered to the caller — set `output.continue = true` with `output.reason` to inject the reason as a synthetic user message and force another turn before delivery. `postStop` fires after delivery (a continue there runs another turn but the new finalText does NOT propagate).

Registration accepts a bare function or `{ matcher, run }`. Default matcher excludes built-in agents (main, general, explore, summary, title, checkpoint-writer, dream, distill, compaction).

```ts
"actor.preStop": {
  matcher: { agentType: { include: ["general"] }, mode: "subagent" },
  run: async (input, output) => {
    // input.actorID, input.agentType, input.task, input.finalText?, input.iteration
    if (!input.finalText?.includes("**Status**:")) {
      output.continue = true
      output.reason = "Your reply is missing the required Status header. Add it."
    }
  },
},
"actor.postStop": async (input, output) => {
  // input.outcome: "success" | "failure" | "cancelled"
  // input.error?: string (when outcome === "failure")
  // input.canWrite?: boolean (false → agent had no Write tool; don't demand file output)
}
```

### experimental.text.complete

Fires when a text part finishes streaming. Read-only inspection of the final text.

```ts
"experimental.text.complete": async (input, output) => {
  // input.sessionID, input.messageID, input.partID
  // output.text: string
}
```

## Examples

### Safety guard
```ts
export default {
  "tool.execute.before": async (input, output) => {
    if (input.tool === "bash") {
      const cmd = output.args.command ?? ""
      if (/rm\s+-rf\s+\//.test(cmd)) {
        output.cancel = true
        output.cancelReason = "Blocked: dangerous rm -rf on root"
      }
    }
  },
}
```

### Auto-approve reads
```ts
export default {
  "permission.ask": async (input, output) => {
    if (input.permission === "read" || input.permission === "glob" || input.permission === "grep") {
      output.status = "allow"
    }
  },
}
```

### Inject project context into system prompt
```ts
import { readFileSync } from "fs"

export default {
  "experimental.chat.system.transform": async (input, output) => {
    try {
      const ctx = readFileSync(".mimocode/project-context.md", "utf-8")
      output.system.push(ctx)
    } catch {}
  },
}
```
