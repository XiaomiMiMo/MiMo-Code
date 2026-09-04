import { z } from "zod"
import { Effect } from "effect"

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  /**
   * Current project directory for this session.
   * Prefer this over process.cwd() when resolving relative paths.
   */
  directory: string
  /**
   * Project worktree root for this session.
   * Useful for generating stable relative paths (e.g. path.relative(worktree, absPath)).
   */
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Effect.Effect<void>
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}

export type ToolResult = string | { output: string; metadata?: { [key: string]: any } }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  /**
   * Optional pre-derived JSON Schema for the provider-facing tool parameters.
   * When set, the engine advertises this object as-is instead of
   * `z.toJSONSchema(z.object(args))`.
   *
   * Needed for self-contained/bundled tools whose zod copy is not the engine's
   * instance: `.meta()` / `.describe()` live in that copy's registry and are
   * invisible to the engine's `toJSONSchema` (e.g. a nested union would lose
   * the `type: "object"` sibling of `anyOf`). Omit for in-process tools that
   * share the engine zod — those keep deriving the wire schema from `args`.
   */
  jsonSchema?: Record<string, unknown>
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
