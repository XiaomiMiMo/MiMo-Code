import { useTheme } from "@tui/context/theme"
import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import type { WorkflowNode } from "@tui/context/sync"

type AgentNode = Extract<WorkflowNode, { type: "agent" }>
type WfNode = Extract<WorkflowNode, { type: "workflow" }>
type PhaseNode = Extract<WorkflowNode, { type: "phase" }>

// Flatten the program-ordered node list into indented rows: phases at depth 0,
// agents/workflows at depth 1 under their phase (depth 0 when no phase yet).
function layout(nodes: WorkflowNode[]) {
  return nodes.map((node) => ({ depth: node.type === "phase" ? 0 : node.phaseId ? 1 : 0, node }))
}

function glyph(status: string) {
  if (status === "succeeded" || status === "completed") return "✓"
  if (status === "failed" || status === "cancelled") return "✗"
  if (status === "running") return "⟳"
  return "○"
}

function truncate(s: string, n: number) {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat
}

// One-line meta tag for an agent call's parameters: model · tools · schema ·
// isolated · duration. Empty parts are dropped.
function agentMeta(n: AgentNode) {
  const parts: string[] = []
  if (n.model) parts.push(n.model)
  if (n.tools && n.tools.length) parts.push(`tools:${n.tools.length}`)
  if (n.schema) parts.push("schema")
  if (n.isolation) parts.push("isolated")
  if (n.durationMs !== undefined) parts.push(`${(n.durationMs / 1000).toFixed(1)}s`)
  return parts.join(" · ")
}

export function WorkflowTree(props: {
  nodes: WorkflowNode[]
  onOpenChild?: (childRunID: string) => void
  onOpenAgent?: (actorID: string) => void
}) {
  const { theme } = useTheme()
  const statusColor = (s: string) =>
    s === "succeeded" || s === "completed"
      ? theme.success
      : s === "failed" || s === "cancelled"
        ? theme.error
        : s === "running"
          ? theme.warning
          : theme.textMuted
  const rows = () => layout(props.nodes)
  return (
    <box flexDirection="column">
      <Show when={rows().length === 0}>
        <text fg={theme.textMuted}>(no structure yet)</text>
      </Show>
      <For each={rows()}>
        {(row) => (
          <box paddingLeft={row.depth * 2} flexDirection="column">
            <Show when={row.node.type === "phase"}>
              <text attributes={TextAttributes.BOLD} fg={theme.accent}>
                ▸ {(row.node as PhaseNode).title}
              </text>
            </Show>

            <Show when={row.node.type === "agent"}>
              {/* line 1: glyph + name + meta(model/tools/schema/duration). The name
                  is clickable (→ that subagent's full conversation) once the agent
                  has spawned (actorID present) and a handler is provided. */}
              <box flexDirection="row" gap={1}>
                <text fg={statusColor((row.node as AgentNode).status)}>{glyph((row.node as AgentNode).status)}</text>
                <text
                  attributes={TextAttributes.BOLD}
                  fg={(row.node as AgentNode).actorID && props.onOpenAgent ? theme.markdownLink : theme.text}
                  onMouseUp={() => {
                    const a = row.node as AgentNode
                    if (a.actorID) props.onOpenAgent?.(a.actorID)
                  }}
                >
                  {(row.node as AgentNode).label ?? (row.node as AgentNode).agentType}
                  {(row.node as AgentNode).actorID && props.onOpenAgent ? " ↗" : ""}
                </text>
                <Show when={agentMeta(row.node as AgentNode)}>
                  <text fg={theme.textMuted}>{agentMeta(row.node as AgentNode)}</text>
                </Show>
              </box>
              {/* line 2: the prompt (the call's primary parameter), indented + dimmed */}
              <box paddingLeft={2}>
                <text fg={theme.textMuted}>{truncate((row.node as AgentNode).prompt, 100)}</text>
              </box>
            </Show>

            <Show when={row.node.type === "workflow"}>
              <text
                fg={theme.markdownLink}
                onMouseUp={() => props.onOpenChild?.((row.node as WfNode).childRunID)}
              >
                ▸ workflow: {(row.node as WfNode).name} ↗
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}
