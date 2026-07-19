// Late-bound reference to the tool set executable from inside tool_script.
//
// tool_script needs the full ToolRegistry def list to dispatch guest RPC calls,
// but the registry itself constructs tool_script (registry → tool_script →
// registry would be a module cycle). Mirroring workflowRef (workflow/runtime-ref.ts):
// the registry layer populates this module-local reference on initialisation and
// the tool reads it at call time.
import type { Effect } from "effect"
import type { Tool as AiTool } from "ai"
import type * as Tool from "./tool"

export const toolScriptRegistry: {
  current: (() => Effect.Effect<Tool.Def[]>) | undefined
} = { current: undefined }

// MCP tools live outside ToolRegistry (SessionPrompt assembles them straight
// from MCP.Service), so tool_script reaches them through this second ref,
// populated by the SessionPrompt layer. Reusing the ref pattern keeps MCP's
// layer out of the registry graph — providing MCP.defaultLayer to the registry
// would spin up a SECOND set of MCP client connections.
export const toolScriptMcp: {
  current: (() => Effect.Effect<Record<string, AiTool>>) | undefined
} = { current: undefined }

// Agent control-flow tools make no sense inside a script (they steer the
// conversation, not data) — excluded from both the declared API and dispatch.
// bash is excluded as a policy choice, not control-flow: it is the universal
// escape hatch (network, deletes, arbitrary side effects), and burying up to
// 50 shell commands inside one opaque script defeats per-command review even
// though each still triggers Permission.ask. Batch shell work belongs in ONE
// reviewable bash call running a script, not a tool_script loop.
export const TOOL_SCRIPT_EXCLUDED = new Set([
  "tool_script",
  "invalid",
  "question",
  "task",
  "actor",
  "skill",
  "plan_enter",
  "plan_exit",
  "cron",
  "session",
  "workflow",
  "change_directory",
  "bash",
])
