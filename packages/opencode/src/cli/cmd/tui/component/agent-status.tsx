import { For, Show, type JSX } from "solid-js"
import { useTheme } from "@tui/context/theme"
import type { ActorEntry } from "@tui/context/sync"

export interface AgentStatusProps {
  actors: ActorEntry[]
}

export function AgentStatus(props: AgentStatusProps): JSX.Element {
  const { theme } = useTheme()
  const list = () => props.actors ?? []
  const running = () => list().filter((a) => a.status === "running").length

  return (
    <Show when={list().length > 0}>
      <box
        flexDirection="column"
        backgroundColor={theme.backgroundPanel}
        border={["left", "right"]}
        borderColor={theme.border}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
      >
        <box flexDirection="row" alignItems="center" marginBottom={1}>
          <text fg={theme.textMuted}>{"Agents"}</text>
          <Show when={running() > 0}>
            <text fg={theme.text}>{` . ${running()} running`}</text>
          </Show>
        </box>
        <For each={list()}>
          {(actor) => (
            <box flexDirection="row" alignItems="center" marginBottom={0}>
              <text fg={actor.status === "running" ? theme.text : theme.textMuted}>
                {actor.status === "running" ? "O" : "o"}
              </text>
              <text fg={theme.text} marginLeft={1}>
                {actor.description || actor.agent || actor.actor_id}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
