import { createSignal } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { SplitBorder } from "@tui/component/border"

export function UserMessageBubble(props: {
  id?: string
  marginTop?: number
  borderColor: RGBA
  backgroundColor: RGBA
  hoverColor: RGBA
  onMouseUp?: () => void
  children: JSX.Element
}) {
  const [hover, setHover] = createSignal(false)
  return (
    <box id={props.id} border={["left"]} borderColor={props.borderColor}
      customBorderChars={SplitBorder.customBorderChars} marginTop={props.marginTop ?? 1}>
      <box onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)} onMouseUp={props.onMouseUp}
        paddingTop={1} paddingBottom={1} paddingLeft={2} flexShrink={0}
        backgroundColor={hover() ? props.hoverColor : props.backgroundColor}>
        {props.children}
      </box>
    </box>
  )
}
