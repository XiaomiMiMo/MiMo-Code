export type InvocationStyle = "json" | "shell"

// Shape of the `tool` config block (config.ts: cfg.tool). Kept structural so the
// helper has no dependency on the Config service — it's a pure decision function.
export interface ToolStyleConfig {
  invocation_style?: InvocationStyle
  invocation_style_by_tool?: Record<string, InvocationStyle>
}

// Single source of truth for "which invocation style is tool <toolId> in".
// Per-tool override wins; otherwise the global default; otherwise "json".
// NOTE: this resolves the *configured* style. A tool with no `shell` field still
// falls back to JSON at the registry (tool.shell !== undefined guard) — callers
// that care about the rendered form must also know whether the tool has a shell.
export function resolveInvocationStyle(cfg: ToolStyleConfig | undefined, toolId: string): InvocationStyle {
  return cfg?.invocation_style_by_tool?.[toolId] ?? cfg?.invocation_style ?? "json"
}
