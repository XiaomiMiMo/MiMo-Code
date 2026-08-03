import { createSignal } from "solid-js"
import type { MouseEvent, Renderable } from "@opentui/core"

/**
 * Click gate: fires only when press and release both land on the element, once per press.
 * Guards against opentui delivering a bare `up` to whatever sits under the cursor when a
 * drag captured elsewhere (a scrollbar, a text selection) ends there.
 */
export function createPress(onPress: () => void) {
  const [hover, setHover] = createSignal(false)
  let node: Renderable | undefined
  let armed = false

  const inside = (evt: MouseEvent) =>
    !!node &&
    evt.x >= node.x &&
    evt.x < node.x + node.width &&
    evt.y >= node.y &&
    evt.y < node.y + node.height

  return {
    hover,
    props: {
      ref: (r: Renderable) => {
        node = r
      },
      // A press can end without this element ever seeing `out` or `up`, so every event
      // proving the pointer is no longer pressing us has to disarm.
      onMouseOver: () => {
        setHover(true)
        armed = false
      },
      onMouseOut: () => {
        setHover(false)
        armed = false
      },
      onMouseDrag: (evt: MouseEvent) => {
        if (inside(evt)) return
        armed = false
      },
      onMouseDrop: () => {
        armed = false
      },
      onMouseDown: (evt: MouseEvent) => {
        armed = inside(evt)
      },
      onMouseUp: (evt: MouseEvent) => {
        if (!armed) return
        // Consume first: a release inside a captured renderable is dispatched twice.
        armed = false
        // A release closing a text-selection drag arrives here with no preceding `drop`;
        // it is never a click on us. Requires our own content to be unselectable, or our
        // own press would start a selection and land in this branch too.
        if (evt.isDragging) return
        if (!inside(evt)) return
        onPress()
      },
    },
  }
}
