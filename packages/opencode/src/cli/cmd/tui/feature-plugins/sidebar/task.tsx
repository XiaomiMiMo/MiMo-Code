import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { createMemo, Index, Show, createSignal } from "solid-js"
import { TaskItem } from "../../component/task-item"

const id = "internal:sidebar-task"

// Active tasks render in full; completed tasks show a short recent tail (so the
// user gets "what just finished" feedback) with the rest folded behind a
// clickable "N more done" row. abandoned tasks stay hidden — drops, not wins.
const RECENT_DONE_LIMIT = 3

function depthOf(taskId: string): number {
  return taskId.match(/\./g)?.length ?? 0
}

const STATUS_ORDER: Record<string, number> = { in_progress: 0, open: 1, blocked: 2 }

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const [doneExpanded, setDoneExpanded] = createSignal(false)
  const theme = () => props.api.theme.current
  const all = createMemo(() => props.api.state.session.task(props.session_id))
  // Active work, ordered in_progress → open(todo) → blocked; ties broken by id
  // so same-status rows keep a stable order across polls (no visual jitter).
  const active = createMemo(() =>
    all()
      .filter((t) => t.status === "open" || t.status === "in_progress" || t.status === "blocked")
      .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.id.localeCompare(b.id)),
  )
  // Completed, most-recently-finished first; id tiebreak for stable order.
  const done = createMemo(() =>
    all()
      .filter((t) => t.status === "done")
      .sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0) || a.id.localeCompare(b.id)),
  )
  const visibleDone = createMemo(() => (doneExpanded() ? done() : done().slice(0, RECENT_DONE_LIMIT)))
  const hiddenDoneCount = createMemo(() => Math.max(0, done().length - visibleDone().length))
  const rows = createMemo(() => [...active(), ...visibleDone()])
  const show = createMemo(() => rows().length > 0)
  // Panel-level collapse appears once there's more than a couple of rows.
  const collapsible = createMemo(() => rows().length + (hiddenDoneCount() > 0 ? 1 : 0) > 2)

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => collapsible() && setOpen((x) => !x)}>
          <Show when={collapsible()}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Tasks</b>
          </text>
        </box>
        <Show when={!collapsible() || open()}>
          <Index each={rows()}>
            {(item) => (
              <TaskItem
                id={item().id}
                status={item().status}
                summary={item().summary}
                owner={item().owner ?? undefined}
                depth={depthOf(item().id)}
              />
            )}
          </Index>
          <Show when={hiddenDoneCount() > 0 || doneExpanded()}>
            <box flexDirection="row" gap={0} onMouseDown={() => setDoneExpanded((x) => !x)}>
              <text fg={theme().textMuted}>
                {doneExpanded() ? "  ▾ fewer done" : `  ▸ ${hiddenDoneCount()} more done`}
              </text>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
