import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useVisualMode } from "../context/visual"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import "opentui-spinner/solid"

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const visual = useVisualMode()
  const color = () => props.color ?? theme.textMuted
  return (
    <Show when={visual.motion()} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner frames={frames} interval={80} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
