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

export const GPT_TOOL_SCRIPT_ONLY = new Set([
  "bash",
  "apply_patch",
  "view_image",
  "actor",
  "task",
  "question",
  "webfetch",
  "skill_search",
  "skill",
  "change_directory",
  "plan_exit",
  "memory",
  "history",
  "cron",
])

// Recursive orchestration and internal sentinel tools stay outside scripts.
// Other control-flow tools are intentionally callable through `tools.<id>` so
// the GPT/Codex toolset can expose a single outer `exec` surface.
export const TOOL_SCRIPT_EXCLUDED = new Set([
  "exec",
  "mcp_tool_search",
  "invalid",
  "session",
  "workflow",
])

// Reserved aliases share the target definition and therefore its permission,
// execution, timeout, and truncation behavior.
export const TOOL_SCRIPT_ALIASES = {
  exec_command: "bash",
} as const
