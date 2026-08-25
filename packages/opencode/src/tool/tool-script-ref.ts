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
import type { HarnessMode } from "./gpt"

export const toolScriptRegistry: {
  current:
    | ((input?: {
        providerID: ProviderID
        modelID: ModelID
        apiModelID?: string
        family?: string
        agent: Agent.Info
        harness?: HarnessMode
      }) => Effect.Effect<Tool.Def[]>)
    | undefined
} = { current: undefined }

// Codex keeps one compact advertised surface while the runtime still registers
// every authorized tool for compatibility with direct calls emitted by the
// model. `wait` is reserved for the standalone tool once it is available.
export const GPT_TOP_LEVEL_TOOLS = new Set(["exec", "wait"])

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
