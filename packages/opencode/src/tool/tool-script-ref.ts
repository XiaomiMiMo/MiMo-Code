// Late-bound reference to the tool set executable from inside exec.
//
// exec needs the ToolRegistry def list to dispatch guest RPC calls, but the
// registry itself constructs exec (registry → exec →
// registry would be a module cycle). Mirroring workflowRef (workflow/runtime-ref.ts):
// the registry layer populates this module-local reference on initialisation and
// the tool reads it at call time.
import type { Effect } from "effect"
import type { Agent } from "../agent/agent"
import type { ModelID, ProviderID } from "../provider/schema"
import type * as Tool from "./tool"

export const toolScriptRegistry: {
  current:
    | ((input?: { providerID: ProviderID; modelID: ModelID; agent: Agent.Info }) => Effect.Effect<Tool.Def[]>)
    | undefined
} = { current: undefined }

// Agent control-flow tools make no sense inside a script (they steer the
// conversation, not data) — excluded from both the declared API and dispatch.
export const TOOL_SCRIPT_EXCLUDED = new Set([
  "exec",
  "mcp_tool_search",
  "invalid",
  "question",
  "task",
  "actor",
  "skill",
  "plan_exit",
  "cron",
  "session",
  "workflow",
  "change_directory",
])

// Reserved aliases share the target definition and therefore its permission,
// execution, timeout, and truncation behavior.
export const TOOL_SCRIPT_ALIASES = {
  exec_command: "bash",
} as const
