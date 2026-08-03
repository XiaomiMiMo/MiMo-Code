import { createSignal } from "solid-js"
import type { MouseEvent, Renderable } from "@opentui/core"

/**
 * Click gate: fires only when press and release both land on the element, once per press.
 * Guards against opentui delivering a bare `up` to whatever sits under the cursor when a
 * drag captured elsewhere (a scrollbar, a text selection) ends there.
 *
 * The element's own content must be unselectable (`selectable={false}` on any `<text>`),
 * otherwise its own press starts a text selection and every release is discarded as a
 * selection drag — a silently dead control.
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
      // opentui dispatches out/over on intra-element hit changes too (child glyph vs the
      // box itself) and they bubble here, so only a pointer that actually left disarms.
      onMouseOver: (evt: MouseEvent) => {
        setHover(true)
        if (inside(evt)) return
        armed = false
      },
      onMouseOut: (evt: MouseEvent) => {
        if (inside(evt)) return
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
        // A release closing a text-selection drag arrives with no preceding `drop`; it is
        // never a click on us.
        if (evt.isDragging) return
        if (!inside(evt)) return
        onPress()
      },
    },
  }
}
