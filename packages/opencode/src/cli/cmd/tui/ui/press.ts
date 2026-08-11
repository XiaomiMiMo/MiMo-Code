import { createSignal } from "solid-js"
import type { MouseEvent, Renderable } from "@opentui/core"

/**
 * Click gate for controls where a mis-fire is costly — one sitting next to a drag surface
 * (a scrollbar, selectable transcript text) whose action the user cannot casually undo.
 * Fires only when the press and the release both land on the element and the pointer never
 * left its bounds in between. Movement within the element is fine.
 *
 * NOT a general replacement for `onMouseUp`. Plain `onMouseUp` is correct for the great
 * majority of controls, and routing one through here only costs it dropped clicks. Adopt
 * this only when an accidental activation is the problem being solved.
 *
 * Ambiguity resolves toward not firing: a dropped click is a non-event the user repeats,
 * while an unintended one is the bug this exists to prevent. Leaving the element and
 * returning does not produce a click — browser semantics are not the goal.
 *
 * Known limitation: a press that arrives with no preceding pointer movement onto the
 * element cannot be disarmed when it drags away, because opentui then delivers the element
 * no event at all for that press. Real pointers always generate that movement first.
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
      // opentui raises out/over on intra-element hit changes too — a child glyph and the
      // box's own cells are separate hit targets, and both events bubble here — so only a
      // pointer whose new position is outside our bounds counts as having left.
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
