import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import "opentui-spinner/solid"

// Inlined (not the shared <Spinner>) so the animated glyph occupies exactly
// one column inside the `[ ]` marker — matching the width and trailing space
// of the static `[{glyph}] ` markers so every row's text aligns.
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export interface TaskItemProps {
  id: string
  status: string
  summary: string
  owner?: string
  depth: number
}

export function TaskItem(props: TaskItemProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const running = () => props.status === "in_progress"
  const glyph =
    props.status === "done"
      ? "✓"
      : props.status === "blocked"
        ? "⏸"
        : props.status === "abandoned"
          ? "✗"
          : " "
  const fg = () => (running() ? theme.warning : theme.textMuted)
  const indent = "  ".repeat(props.depth)

  return (
    <box flexDirection="row" gap={0}>
      <text flexShrink={0} style={{ fg: fg() }}>
        {indent}
      </text>
      <Show
        when={running()}
        fallback={
          <text flexShrink={0} style={{ fg: fg() }}>
            [{glyph}]{" "}
          </text>
        }
      >
        <box flexShrink={0} flexDirection="row" gap={0}>
          <text style={{ fg: theme.warning }}>[</text>
          <Show
            when={kv.get("animations_enabled", true)}
            fallback={<text style={{ fg: theme.warning }}>•</text>}
          >
            <spinner frames={spinnerFrames} interval={80} color={theme.warning} />
          </Show>
          <text style={{ fg: theme.warning }}>]{" "}</text>
        </box>
      </Show>
      <text flexGrow={1} wrapMode="word" style={{ fg: fg() }}>
        <span style={{ fg: theme.textMuted }}>{props.id}</span> {props.summary}
      </text>
    </box>
  )
}
