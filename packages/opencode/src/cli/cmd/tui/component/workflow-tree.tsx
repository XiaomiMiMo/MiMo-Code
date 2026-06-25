import { useTheme } from "@tui/context/theme"
import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import type { WorkflowNode } from "@tui/context/sync"

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

export function WorkflowTree(props: { nodes: WorkflowNode[]; onOpenChild?: (childRunID: string) => void }) {
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
          <box paddingLeft={row.depth * 2} flexDirection="row" gap={1}>
            <Show when={row.node.type === "phase"}>
              <text attributes={TextAttributes.BOLD} fg={theme.accent}>
                ▸ {(row.node as Extract<WorkflowNode, { type: "phase" }>).title}
              </text>
            </Show>
            <Show when={row.node.type === "agent"}>
              <text fg={statusColor((row.node as Extract<WorkflowNode, { type: "agent" }>).status)}>
                {glyph((row.node as Extract<WorkflowNode, { type: "agent" }>).status)}
              </text>
              <text fg={theme.text}>
                {(row.node as Extract<WorkflowNode, { type: "agent" }>).label ??
                  (row.node as Extract<WorkflowNode, { type: "agent" }>).agentType}
              </text>
            </Show>
            <Show when={row.node.type === "workflow"}>
              <text
                fg={theme.markdownLink}
                onMouseUp={() => props.onOpenChild?.((row.node as Extract<WorkflowNode, { type: "workflow" }>).childRunID)}
              >
                ▸ workflow: {(row.node as Extract<WorkflowNode, { type: "workflow" }>).name} ↗
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}
