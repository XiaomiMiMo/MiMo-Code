import { createMemo, For, Show } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { Part } from "@mimo-ai/sdk/v2"
import { parseAgentInboxPart } from "@/inbox/render"
import { UserMessageBubble } from "./user-message-bubble"

export function AgentInboxMessages(props: {
  agentID: string
  messageID: string
  parts: Part[]
  label: (from: string) => string
  color: RGBA
  borderColor: RGBA
  backgroundColor: RGBA
  hoverColor: RGBA
}) {
  const messages = createMemo(() => props.agentID === "main" ? [] : props.parts.flatMap((part) => {
    const message = parseAgentInboxPart(part)
    return message ? [message] : []
  }))
  return (
    <Show when={messages().length}>
      <box id={props.messageID} flexDirection="column">
        <For each={messages()}>
          {(message) => (
            <UserMessageBubble borderColor={props.borderColor} backgroundColor={props.backgroundColor} hoverColor={props.hoverColor}>
              <text fg={props.borderColor}><b>{props.label(message.from)}</b></text>
              <text fg={props.color}>{message.text}</text>
            </UserMessageBubble>
          )}
        </For>
      </box>
    </Show>
  )
}
