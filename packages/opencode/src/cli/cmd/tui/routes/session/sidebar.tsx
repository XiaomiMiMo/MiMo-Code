import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useRoute } from "@tui/context/route"
import { useLanguage } from "@tui/context/language"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Locale } from "@/util"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationChannel, InstallationVersion } from "@/installation/version"
import { SplitBorder } from "@tui/component/border"
import { TuiPluginRuntime } from "../../plugin"

import { getScrollAcceleration } from "../../util/scroll"

export function Sidebar(props: { sessionID: string; overlay?: boolean; scrollToMessage?: (messageID: string) => void }) {
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const t = useLanguage().t
  const [tab, setTab] = createSignal<"info" | "sessions" | "instructions">("info")
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspaceStatus = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return "error"
    return project.workspace.status(workspaceID) ?? "error"
  }
  const workspaceLabel = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return "unknown"
    const info = project.workspace.get(workspaceID)
    if (!info) return "unknown"
    return `${info.type}: ${info.name}`
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  const tabs = [
    { id: "info" as const, label: () => t("tui.sidebar.tabs.info") },
    { id: "sessions" as const, label: () => t("tui.sidebar.tabs.sessions") },
    { id: "instructions" as const, label: () => t("tui.sidebar.tabs.instructions") },
  ]

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <box flexShrink={0} flexDirection="row" gap={2} paddingBottom={1}>
          <For each={tabs}>
            {(item) => (
              <text
                fg={tab() === item.id ? theme.text : theme.textMuted}
                selectable={false}
                onMouseUp={() => setTab(item.id)}
              >
                <Show when={tab() === item.id} fallback={item.label()}>
                  <b>{item.label()}</b>
                </Show>
              </text>
            )}
          </For>
        </box>

        <Switch>
          <Match when={tab() === "info"}>
            <scrollbox
              flexGrow={1}
              scrollAcceleration={scrollAcceleration()}
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: theme.background,
                  foregroundColor: theme.borderActive,
                },
              }}
            >
              <box flexShrink={0} gap={1} paddingRight={1}>
                <TuiPluginRuntime.Slot
                  name="sidebar_title"
                  mode="single_winner"
                  session_id={props.sessionID}
                  title={session()!.title}
                  share_url={session()!.share?.url}
                >
                  <box paddingRight={1}>
                    <text fg={theme.text}>
                      <b>{session()!.title}</b>
                    </text>
                    <Show when={InstallationChannel !== "latest"}>
                      <text fg={theme.textMuted}>{props.sessionID}</text>
                    </Show>
                    <Show when={session()!.workspaceID}>
                      <text fg={theme.textMuted}>
                        <span style={{ fg: workspaceStatus() === "connected" ? theme.success : theme.error }}>●</span>{" "}
                        {workspaceLabel()}
                      </text>
                    </Show>
                    <Show when={session()!.share?.url}>
                      <text fg={theme.textMuted}>{session()!.share!.url}</text>
                    </Show>
                  </box>
                </TuiPluginRuntime.Slot>
                <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
              </box>
            </scrollbox>
          </Match>
          <Match when={tab() === "sessions"}>
            <SessionsTab />
          </Match>
          <Match when={tab() === "instructions"}>
            <InstructionsTab sessionID={props.sessionID} onScroll={props.scrollToMessage} />
          </Match>
        </Switch>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </TuiPluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}

function SessionsTab() {
  const sync = useSync()
  const route = useRoute()
  const { theme } = useTheme()
  const t = useLanguage().t
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const current = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const sessions = createMemo(() =>
    sync.data.session
      .filter((x) => x.parentID === undefined)
      .toSorted((a, b) => {
        const updatedDay = new Date(b.time.updated).setHours(0, 0, 0, 0) - new Date(a.time.updated).setHours(0, 0, 0, 0)
        if (updatedDay !== 0) return updatedDay
        return b.time.created - a.time.created
      }),
  )

  return (
    <scrollbox
      flexGrow={1}
      scrollAcceleration={scrollAcceleration()}
      verticalScrollbarOptions={{
        trackOptions: {
          backgroundColor: theme.background,
          foregroundColor: theme.borderActive,
        },
      }}
    >
      <box flexShrink={0} gap={1} paddingRight={1}>
        <Row label={`+ ${t("tui.sidebar.sessions.new")}`} accent onClick={() => route.navigate({ type: "home" })} />
        <For each={sessions()}>
          {(item) => (
            <Row
              label={item.title}
              active={item.id === current()}
              onClick={() => route.navigate({ type: "session", sessionID: item.id })}
            />
          )}
        </For>
      </box>
    </scrollbox>
  )
}

function InstructionsTab(props: { sessionID: string; onScroll?: (messageID: string) => void }) {
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const instructions = createMemo(() =>
    (sync.data.message[props.sessionID]?.["main"] ?? []).flatMap((message) => {
      if (message.role !== "user") return []
      const text = (sync.data.part[message.id] ?? []).flatMap((part) =>
        part.type === "text" && !part.synthetic ? [part.text] : [],
      )[0]
      if (!text) return []
      return [{ id: message.id, text }]
    }),
  )

  return (
    <scrollbox
      flexGrow={1}
      scrollAcceleration={scrollAcceleration()}
      verticalScrollbarOptions={{
        trackOptions: {
          backgroundColor: theme.background,
          foregroundColor: theme.borderActive,
        },
      }}
    >
      <box flexShrink={0} gap={1} paddingRight={1}>
        <For each={instructions()}>
          {(item) => <Row label={item.text} onClick={() => props.onScroll?.(item.id)} />}
        </For>
      </box>
    </scrollbox>
  )
}

function Row(props: { label: string; active?: boolean; accent?: boolean; onClick: () => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const borderColor = () => {
    if (props.accent) return theme.accent
    return props.active || hover() ? theme.borderActive : theme.border
  }
  const textColor = () => {
    if (props.accent) return theme.accent
    return props.active ? theme.text : theme.textMuted
  }
  return (
    <box
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={props.onClick}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={borderColor()}
    >
      <box
        paddingLeft={1}
        backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      >
        <text fg={textColor()}>{Locale.truncate(props.label.replaceAll("\n", " "), 36)}</text>
      </box>
    </box>
  )
}
