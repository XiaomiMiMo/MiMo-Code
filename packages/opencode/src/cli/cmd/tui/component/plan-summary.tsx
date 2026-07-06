import { For, Show, type JSX } from "solid-js"
import { useTheme } from "@tui/context/theme"
import type { Todo } from "@mimo-ai/sdk/v2"

type TaskEntry = {
  id: string
  session_id: string
  parent_task_id?: string
  status: string
  summary: string
  owner?: string
  created_at: number
  last_event_at: number
  ended_at?: number
  cleanup_after?: number
}

export interface PlanSummaryProps {
  tasks: TaskEntry[]
  todos: Todo[]
}

const taskGlyph = (status: string): string => {
  switch (status) {
    case "done":
    case "completed":
      return "v"
    case "in_progress":
    case "running":
      return ">"
    case "abandoned":
    case "failed":
      return "x"
    case "blocked":
    case "open":
    case "pending":
    default:
      return "."
  }
}

const todoGlyph = (status: string): string => {
  switch (status) {
    case "completed":
      return "v"
    case "in_progress":
      return ">"
    case "pending":
    case "cancelled":
    default:
      return "."
  }
}

export function PlanSummary(props: PlanSummaryProps): JSX.Element {
  const { theme } = useTheme()
  const tasks = () => props.tasks ?? []
  const todos = () => props.todos ?? []
  const hasAny = () => tasks().length > 0 || todos().length > 0

  return (
    <Show when={hasAny()}>
      <box
        flexDirection="row"
        backgroundColor={theme.backgroundPanel}
        border={["left", "right"]}
        borderColor={theme.border}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        gap={2}
      >
        <Show when={tasks().length > 0}>
          <box flexDirection="column" flexGrow={1}>
            <text fg={theme.textMuted}>{`Tasks (${tasks().length})`}</text>
            <For each={tasks()}>
              {(task) => (
                <box flexDirection="row" alignItems="center">
                  <text fg={task.status === "in_progress" || task.status === "running" ? theme.text : theme.textMuted}>
                    {taskGlyph(task.status)}
                  </text>
                  <text fg={theme.text} marginLeft={1}>
                    {task.summary}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
        <Show when={todos().length > 0}>
          <box flexDirection="column" flexGrow={1}>
            <text fg={theme.textMuted}>{`Todos (${todos().length})`}</text>
            <For each={todos()}>
              {(todo) => (
                <box flexDirection="row" alignItems="center">
                  <text fg={todo.status === "in_progress" ? theme.text : theme.textMuted}>
                    {todoGlyph(todo.status)}
                  </text>
                  <text fg={theme.text} marginLeft={1}>
                    {todo.content}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}
