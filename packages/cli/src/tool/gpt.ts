import { Flag } from "@/flag/flag"
import type { McpToolSearchMode } from "./mcp-tool-search"

export type HarnessMode = "auto" | "codex" | "default"

// Codex mode (the `exec` toolset plus the Codex system prompt) is opt-in and
// independent of the model: MIMOCODE_CODEX_MODE=false always wins, an explicit
// session harness decides next, and otherwise only MIMOCODE_CODEX_MODE=true
// enables it.
export function usesCodexMode(harness?: HarnessMode) {
  const mode = Flag.MIMOCODE_CODEX_MODE
  if (mode === false) return false
  if (harness === "codex") return true
  if (harness === "default") return false
  return mode === true
}

export function mcpToolSearchMode(configured: McpToolSearchMode, harness: HarnessMode | undefined): McpToolSearchMode {
  if (usesCodexMode(harness)) return { type: "always" }
  return configured
}
