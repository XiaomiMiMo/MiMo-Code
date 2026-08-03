import { createSignal } from "solid-js"
import type { MouseEvent, Renderable } from "@opentui/core"

/**
 * Click gate for small controls: fires only on a stable click — press and release on the
 * element with no `out` in between. Anything less is dropped, deliberately. Dropping a
 * click is a non-event the user repeats; firing one they did not intend is not, and
 * opentui hands a bare `up` to whatever sits under the cursor when a drag captured
 * elsewhere (a scrollbar, a text selection) ends there.
 *
 * `out` arrives on intra-element hit changes too (a child glyph and the box's own cells
 * are separate hit targets), so a press that drifts even one cell is discarded. That is
 * the intended trade, not an oversight.
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
        // A release closing a text-selection drag arrives with no preceding `drop`; it is
        // never a click on us.
        if (evt.isDragging) return
        if (!inside(evt)) return
        onPress()
      },
    },
  }
}
