import { For } from "solid-js"
import type { RGBA } from "@opentui/core"

export function ActorNotificationWarnings(props: { warnings?: string[]; label: string; color: RGBA }) {
  return (
    <For each={props.warnings}>
      {(warning) => (
        <span style={{ fg: props.color }}>
          {"\n"}
          {props.label}: {warning}
        </span>
      )}
    </For>
  )
}
