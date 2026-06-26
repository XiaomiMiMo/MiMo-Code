import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo, onCleanup, onMount } from "solid-js"

export function DialogWorkflows() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  // Initial fetch + poll-while-open for live counters. The DB-mirrored counters
  // (✓/✗/⟳) update faster than the bus phase/finished deltas, so a light poll
  // keeps the rows fresh while the dialog is on screen; cleared on close.
  onMount(() => {
    const sid = currentSessionID()
    if (sid) sync.loadWorkflows(sid)
    const interval = setInterval(() => {
      const s = currentSessionID()
      if (s) sync.loadWorkflows(s)
    }, 1000)
    onCleanup(() => clearInterval(interval))
  })

  const runs = createMemo(() => {
    const sid = currentSessionID()
    return Object.values(sync.data.workflow)
      .filter((r) => !sid || r.sessionID === sid)
      .toSorted((a, b) => (a.runID < b.runID ? -1 : 1)) // descending ULID: newest run = smallest string → ascending sort = newest first
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = runs()
    if (list.length === 0)
      return [{ title: "(no workflow runs)", value: "empty", onSelect: (d) => d.clear() }]
    return list.map((r) => ({
      title: `${r.name}  ${r.status}  ${r.currentPhase ?? "-"}  ${r.succeeded}✓ ${r.failed}✗ ${r.running}⟳`,
      value: r.runID,
      // Navigate to the full-screen workflow page (replaces the conversation view,
      // like opening a subagent). Mirrors DialogSubagent's route.navigate.
      onSelect: (d) => {
        if (route.data.type === "session") route.navigate({ ...route.data, workflowRunID: r.runID })
        d.clear()
      },
    }))
  })

  return <DialogSelect title="Workflows" options={options()} />
}
