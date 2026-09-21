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

function array<Item extends z.ZodTypeAny>(item: Item): z.ZodArray<Item>
function array(): z.ZodArray<z.ZodUnknown> & { items<Item extends z.ZodTypeAny>(item: Item): z.ZodArray<Item> }
function array(item?: z.ZodTypeAny) {
  if (item) return z.array(item)
  return Object.assign(z.array(z.unknown()), {
    items: <Item extends z.ZodTypeAny>(next: Item) => z.array(next),
  })
}

const schema: Omit<typeof z, "array"> & { array: typeof array } = { ...z, array }

export type ToolResult = string | { output: string; metadata?: { [key: string]: any } }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = schema

export type ToolDefinition = ReturnType<typeof tool>
