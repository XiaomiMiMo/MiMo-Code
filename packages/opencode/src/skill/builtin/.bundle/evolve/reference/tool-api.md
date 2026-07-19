# Tool API Reference

## File Format

```ts
import { tool } from "@mimo-ai/plugin"

// Single tool (default export)
export default tool({
  description: string,       // LLM reads this to decide when to use
  args: {                    // Zod schema for parameters
    [key]: tool.schema.xxx()
  },
  execute: async (args, ctx) => string | { output: string, metadata?: Record<string, any> }
})

// Multiple tools (named exports)
export const myTool = tool({ ... })
export const otherTool = tool({ ... })
```

## tool.schema (Zod)

```ts
tool.schema.string()                    // z.string()
tool.schema.string().optional()         // z.string().optional()
tool.schema.string().describe("...")    // with description for LLM
tool.schema.number()                    // z.number()
tool.schema.boolean()                   // z.boolean()
tool.schema.enum(["a", "b", "c"])       // z.enum([...])
tool.schema.array(tool.schema.string()) // z.array(z.string())
tool.schema.object({ key: tool.schema.string() })
```

## ToolContext (ctx)

```ts
type ToolContext = {
  sessionID: string        // Current session
  messageID: string        // Current message
  agent: string            // Agent name ("general", "explore", etc.)
  directory: string        // Project root (use for file paths)
  worktree: string         // Git worktree root
  abort: AbortSignal       // Cancelled when user interrupts
  metadata(input: {        // Update tool call display
    title?: string
    metadata?: Record<string, any>
  }): void
  ask(input: {             // Request user permission before a sensitive action
    permission: string     // Permission name (e.g. "network", "external_directory")
    patterns: string[]     // What's being accessed (shown to user)
    always: string[]       // Patterns the user can choose to "always allow"
    metadata: Record<string, any>
  }): Effect.Effect<void>  // Effect-typed — in plain async code: await Effect.runPromise(ctx.ask({...}))
}
```

## Return Value

```ts
// Simple string output
return "Result text shown to LLM"

// Structured output with metadata
return {
  output: "Result text",
  metadata: {
    // Arbitrary data, shown in TUI tool result panel
    files_changed: 3,
    duration_ms: 1200,
  }
}
```

## Examples

### Wrap a shell command
```ts
import { tool } from "@mimo-ai/plugin"
import { execSync } from "child_process"

export default tool({
  description: "Check if a port is in use",
  args: {
    port: tool.schema.number().describe("Port number to check"),
  },
  async execute(args, ctx) {
    try {
      const result = execSync(`lsof -i :${args.port}`, { encoding: "utf-8", cwd: ctx.directory })
      return `Port ${args.port} is in use:\n${result}`
    } catch {
      return `Port ${args.port} is free`
    }
  },
})
```

### HTTP API call
```ts
import { tool } from "@mimo-ai/plugin"

export default tool({
  description: "Query project's health endpoint",
  args: {
    endpoint: tool.schema.string().optional().describe("Path (default: /health)"),
  },
  async execute(args, ctx) {
    const url = `http://localhost:3000${args.endpoint ?? "/health"}`
    const res = await fetch(url, { signal: ctx.abort })
    const body = await res.text()
    return `${res.status} ${res.statusText}\n${body}`
  },
})
```

## Constraints

- Output truncated at 50KB / 2000 lines
- Use `ctx.abort` for cancellable long-running operations
- Tool id is derived from filename (e.g., `deploy-check.ts` → tool id `deploy-check`)
- Same id as a builtin overrides it (bash, read, edit, write, glob, grep, etc.)
