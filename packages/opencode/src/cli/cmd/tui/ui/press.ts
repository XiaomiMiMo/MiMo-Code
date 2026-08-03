import { createSignal } from "solid-js"
import type { MouseEvent, Renderable } from "@opentui/core"

/**
 * Click gate for controls where a mis-fire is costly — one sitting next to a drag surface
 * (a scrollbar, selectable transcript text) whose action the user cannot casually undo.
 * Fires only on a stable click: press and release on the element with no `out` in between.
 *
 * NOT a general replacement for `onMouseUp`. Plain `onMouseUp` is correct for the great
 * majority of controls, and routing one through here only costs it dropped clicks. Adopt
 * this only when an accidental activation is the problem being solved.
 *
 * Anything less than a stable click is dropped, deliberately: a dropped click is a
 * non-event the user repeats, while an unintended one is the bug this exists to prevent.
 * `out` also arrives on intra-element hit changes (a child glyph and the box's own cells
 * are separate hit targets), so a press that drifts even one cell is discarded. That is
 * the intended trade — browser semantics, where the pointer may leave and return, are
 * explicitly not the goal here.
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
