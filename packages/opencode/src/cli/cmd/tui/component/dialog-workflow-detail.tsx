import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { TextAttributes } from "@opentui/core"
import { createMemo, onCleanup, onMount, For, Show } from "solid-js"
import { WorkflowTree } from "@tui/component/workflow-tree"

// Full single-run view: header (name + status + counters + current phase), the
// structure tree (primary), and the flat phase/log transcript (secondary). Loads
// both on mount and polls while the run is still running. Works for sync and async
// runs identically — the panel is just a window onto the run's live state.
export function DialogWorkflowDetail(props: { runID: string; onOpenChild?: (childRunID: string) => void }) {
  const sync = useSync()
  const { theme } = useTheme()

  const run = createMemo(() => sync.data.workflow[props.runID])
  const transcript = createMemo(() => sync.data.workflowTranscript[props.runID] ?? [])
  const structure = createMemo(() => sync.data.workflowStructure[props.runID] ?? [])

  onMount(() => {
    sync.loadWorkflowTranscript(props.runID)
    sync.loadWorkflowStructure(props.runID)
    const interval = setInterval(() => {
      if (run()?.status === "running") {
        sync.loadWorkflowTranscript(props.runID)
        sync.loadWorkflowStructure(props.runID)
      }
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  const statusColor = createMemo(() => {
    const s = run()?.status
    if (s === "completed") return theme.success
    if (s === "failed") return theme.error
    if (s === "cancelled") return theme.textMuted
    return theme.warning
  })

  return (
    <box flexDirection="column" gap={1} padding={1} backgroundColor={theme.backgroundPanel}>
      <box flexDirection="row" gap={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.accent}>
          {run()?.name ?? props.runID}
        </text>
        <Show when={run()?.status}>
          <text attributes={TextAttributes.BOLD} fg={statusColor()}>
            {run()!.status}
          </text>
        </Show>
        <Show when={run()?.currentPhase}>
          <text fg={theme.textMuted}>· {run()!.currentPhase}</text>
        </Show>
        <Show when={run()}>
          <text fg={theme.success}>{run()!.succeeded}✓</text>
          <text fg={run()!.failed > 0 ? theme.error : theme.textMuted}>{run()!.failed}✗</text>
          <text fg={run()!.running > 0 ? theme.warning : theme.textMuted}>{run()!.running}⟳</text>
        </Show>
      </box>
      <WorkflowTree nodes={structure()} onOpenChild={props.onOpenChild} />
      <Show when={transcript().length > 0}>
        <text fg={theme.textMuted}>transcript</text>
        <box flexDirection="column">
          <For each={transcript()}>
            {(e) => (
              <Show when={e.kind === "phase"} fallback={<text fg={theme.text}>{e.text}</text>}>
                <text attributes={TextAttributes.BOLD} fg={theme.accent}>
                  ▸ {e.text}
                </text>
              </Show>
            )}
          </For>
        </box>
      </Show>
      <Show when={run()?.error}>
        <text fg={theme.error}>{run()!.error}</text>
      </Show>
    </box>
  )
}
