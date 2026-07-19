import { useTheme } from "@tui/context/theme"
import { TextAttributes } from "@opentui/core"
import { For, Show, createSignal } from "solid-js"
import type { WorkflowNode } from "@tui/context/sync"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"

type AgentNode = Extract<WorkflowNode, { type: "agent" }>
type WfNode = Extract<WorkflowNode, { type: "workflow" }>
type PhaseNode = Extract<WorkflowNode, { type: "phase" }>

function glyph(status: string) {
  if (status === "succeeded" || status === "completed") return "✓"
  if (status === "failed" || status === "cancelled") return "✗"
  return "○"
}

// One-line meta tag for an agent call's parameters: model · tools · schema ·
// isolated · duration. Empty parts are dropped.
function agentMeta(n: AgentNode) {
  const parts: string[] = []
  if (n.model) parts.push(n.model)
  if (n.tools && n.tools.length) parts.push(`${n.tools.length} tools`)
  if (n.schema) parts.push("schema")
  if (n.isolation) parts.push("isolated")
  if (n.durationMs !== undefined) parts.push(`${(n.durationMs / 1000).toFixed(1)}s`)
  return parts.join(" · ")
}

// A single agent rendered as a message-style card: a status-colored left spine
// (the TUI's SplitBorder idiom), a header (spinner/glyph + name + meta + open),
// the full prompt, and the result (or live activity while running). Click → open
// that subagent's full conversation.
function AgentCard(props: {
  node: AgentNode
  onOpenAgent?: (actorID: string) => void
  liveActivity?: (actorID: string) => string | undefined
}) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const n = () => props.node
  const running = () => n().status === "running"
  const spine = () =>
    n().status === "succeeded" ? theme.success : n().status === "failed" ? theme.error : theme.warning
  const clickable = () => Boolean(n().actorID && props.onOpenAgent)
  const live = () => (running() && n().actorID && props.liveActivity ? props.liveActivity(n().actorID!) : undefined)

  return (
    <box
      {...SplitBorder}
      border={["left"]}
      borderColor={spine()}
      marginTop={1}
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
      backgroundColor={hover() && clickable() ? theme.backgroundElement : theme.backgroundPanel}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        const a = n()
        if (a.actorID) props.onOpenAgent?.(a.actorID)
      }}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        <Show when={running()} fallback={<text fg={spine()} attributes={TextAttributes.BOLD}>{glyph(n().status)}</text>}>
          <Spinner color={spine()} />
        </Show>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {n().label ?? n().agentType}
        </text>
        <Show when={agentMeta(n())}>
          <text fg={theme.textMuted}>{agentMeta(n())}</text>
        </Show>
        <box flexGrow={1} />
        <Show when={clickable()}>
          <text fg={hover() ? theme.text : theme.markdownLink}>open ↗</text>
        </Show>
      </box>

      <box paddingLeft={2}>
        <text fg={theme.textMuted} wrapMode="word">
          {n().prompt}
        </text>
      </box>

      <Show when={live()}>
        <box paddingLeft={2} flexDirection="row" gap={1}>
          <text fg={theme.warning}>↳</text>
          <text fg={theme.warning} wrapMode="word">
            {live()}
          </text>
        </box>
      </Show>
      <Show when={!running() && n().resultSummary}>
        <box paddingLeft={2} flexDirection="row" gap={1}>
          <text fg={theme.success}>↳</text>
          <text fg={theme.text} wrapMode="word">
            {n().resultSummary}
          </text>
        </box>
      </Show>
    </box>
  )
}

function WorkflowCard(props: { node: WfNode; onOpenChild?: (childRunID: string) => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const spine = () =>
    props.node.status === "completed"
      ? theme.success
      : props.node.status === "failed" || props.node.status === "cancelled"
        ? theme.error
        : theme.warning
  return (
    <box
      {...SplitBorder}
      border={["left"]}
      borderColor={spine()}
      marginTop={1}
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => props.onOpenChild?.(props.node.childRunID)}
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          ⧉ {props.node.name}
        </text>
        <text fg={theme.textMuted}>sub-workflow · {props.node.status}</text>
        <box flexGrow={1} />
        <text fg={hover() ? theme.text : theme.markdownLink}>open ↗</text>
      </box>
    </box>
  )
}

export function WorkflowTree(props: {
  nodes: WorkflowNode[]
  onOpenChild?: (childRunID: string) => void
  onOpenAgent?: (actorID: string) => void
  liveActivity?: (actorID: string) => string | undefined
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column">
      <Show when={props.nodes.length === 0}>
        <text fg={theme.textMuted}>(no activity yet)</text>
      </Show>
      <For each={props.nodes}>
        {(node) => (
          <>
            <Show when={node.type === "phase"}>
              <box marginTop={1} flexDirection="row" gap={1} alignItems="center">
                <text attributes={TextAttributes.BOLD} fg={theme.accent}>
                  ◆ {(node as PhaseNode).title}
                </text>
                <box flexGrow={1} borderColor={theme.borderSubtle} border={["bottom"]} />
              </box>
            </Show>
            <Show when={node.type === "agent"}>
              <AgentCard node={node as AgentNode} onOpenAgent={props.onOpenAgent} liveActivity={props.liveActivity} />
            </Show>
            <Show when={node.type === "workflow"}>
              <WorkflowCard node={node as WfNode} onOpenChild={props.onOpenChild} />
            </Show>
          </>
        )}
      </For>
    </box>
  )
}
