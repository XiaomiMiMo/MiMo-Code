/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createPress } from "../../../src/cli/cmd/tui/ui/press"

// Left half holds selectable text, standing in for the transcript (a left-press there
// starts a text-selection drag); the 3-column button on its right is the press-gated
// control, whose own glyph is unselectable exactly as the real one is.
const NEIGHBOUR = { x: 4, y: 2 }
const BUTTON = { x: 11, y: 2 }
const OUTSIDE = { x: 20, y: 2 }
// The centred glyph's own cell, on the row it occupies — a hit target distinct from the box.
const GLYPH = { x: 11, y: 0 }

async function mount() {
  let presses = 0
  const harness = await testRender(
    () => {
      const press = createPress(() => (presses += 1))
      return (
        <box flexDirection="row">
          <box width={10} height={5}>
            <text>{"transcript text"}</text>
          </box>
          <box width={3} height={5} alignItems="center" {...press.props}>
            <text selectable={false}>{"◀"}</text>
          </box>
          <box width={10} height={5} />
        </box>
      )
    },
    { width: 30, height: 8 },
  )
  await harness.renderOnce()
  return { ...harness, presses: () => presses }
}

describe("createPress", () => {
  test("a plain click fires once", async () => {
    const h = await mount()
    await h.mockMouse.pressDown(BUTTON.x, BUTTON.y)
    await h.mockMouse.release(BUTTON.x, BUTTON.y)
    expect(h.presses()).toBe(1)
  })

  test("a drag captured elsewhere and released on the button does not fire it", async () => {
    const h = await mount()
    await h.mockMouse.pressDown(NEIGHBOUR.x, NEIGHBOUR.y)
    await h.mockMouse.moveTo(NEIGHBOUR.x + 2, NEIGHBOUR.y)
    await h.mockMouse.moveTo(BUTTON.x, BUTTON.y)
    await h.mockMouse.release(BUTTON.x, BUTTON.y)
    expect(h.presses()).toBe(0)
  })

  test("pressing the button then releasing outside it does not fire", async () => {
    const h = await mount()
    await h.mockMouse.pressDown(BUTTON.x, BUTTON.y)
    await h.mockMouse.moveTo(BUTTON.x, BUTTON.y)
    await h.mockMouse.moveTo(OUTSIDE.x, OUTSIDE.y)
    await h.mockMouse.release(OUTSIDE.x, OUTSIDE.y)
    expect(h.presses()).toBe(0)
  })

  test("dragging within the button still fires exactly once on release", async () => {
    const h = await mount()
    await h.mockMouse.pressDown(BUTTON.x, BUTTON.y)
    await h.mockMouse.moveTo(BUTTON.x + 1, BUTTON.y)
    await h.mockMouse.release(BUTTON.x + 1, BUTTON.y)
    expect(h.presses()).toBe(1)
  })

  test("a press that drags off without an out event cannot fire a later foreign drag", async () => {
    const h = await mount()
    // Press the button and drag straight off it. The button is too narrow to become the
    // capture target, so opentui sends it no out, drag, drop or up for this press.
    await h.mockMouse.pressDown(BUTTON.x, BUTTON.y)
    await h.mockMouse.moveTo(NEIGHBOUR.x, NEIGHBOUR.y)
    await h.mockMouse.release(NEIGHBOUR.x, NEIGHBOUR.y)
    expect(h.presses()).toBe(0)

    await h.mockMouse.pressDown(NEIGHBOUR.x, NEIGHBOUR.y)
    await h.mockMouse.moveTo(NEIGHBOUR.x + 2, NEIGHBOUR.y)
    await h.mockMouse.moveTo(BUTTON.x, BUTTON.y)
    await h.mockMouse.release(BUTTON.x, BUTTON.y)
    expect(h.presses()).toBe(0)

    // Positive control: the gate is disarmed, not dead.
    await h.mockMouse.pressDown(BUTTON.x, BUTTON.y)
    await h.mockMouse.release(BUTTON.x, BUTTON.y)
    expect(h.presses()).toBe(1)
  })

  test("a text-selection drag released over the button does not fire it", async () => {
    const h = await mount()
    await h.mockMouse.pressDown(BUTTON.x, BUTTON.y)
    await h.mockMouse.moveTo(NEIGHBOUR.x, NEIGHBOUR.y)
    await h.mockMouse.release(NEIGHBOUR.x, NEIGHBOUR.y)

    // Selecting transcript text takes opentui's selection path, which delivers a bare
    // `up` with isDragging and no preceding `drop`.
    await h.mockMouse.pressDown(2, 0)
    await h.mockMouse.moveTo(5, 0)
    await h.mockMouse.moveTo(BUTTON.x, BUTTON.y)
    await h.mockMouse.release(BUTTON.x, BUTTON.y)
    expect(h.presses()).toBe(0)

    await h.mockMouse.pressDown(BUTTON.x, BUTTON.y)
    await h.mockMouse.release(BUTTON.x, BUTTON.y)
    expect(h.presses()).toBe(1)
  })

  test("a click drifting across the inner glyph boundary still fires", async () => {
    const h = await mount()
    // The glyph is its own hit target, so crossing from it to the box's own cells makes
    // opentui dispatch out/over that bubble here mid-press.
    await h.mockMouse.pressDown(GLYPH.x, GLYPH.y)
    await h.mockMouse.moveTo(GLYPH.x + 1, GLYPH.y)
    await h.mockMouse.release(GLYPH.x + 1, GLYPH.y)
    expect(h.presses()).toBe(1)
  })

  // Mirrors the narrow-terminal sidebar: the collapse control is a raised flex child and
  // the sidebar is a later absolute sibling covering the whole row.
  test("a raised gate stays visible and hit-testable under a later absolute sibling", async () => {
    let presses = 0
    const h = await testRender(
      () => {
        const press = createPress(() => (presses += 1))
        return (
          <box flexDirection="row">
            <box flexGrow={1} />
            <box width={3} height={5} zIndex={1} alignItems="center" {...press.props}>
              <text selectable={false}>{"▶"}</text>
            </box>
            <box position="absolute" top={0} left={0} right={0} bottom={0} alignItems="flex-end">
              <box width={20} height={5} backgroundColor="#333333" />
            </box>
          </box>
        )
      },
      { width: 30, height: 6 },
    )
    await h.renderOnce()
    expect(h.captureCharFrame()).toContain("▶")
    await h.mockMouse.pressDown(28, 0)
    await h.mockMouse.release(28, 0)
    expect(presses).toBe(1)
  })
})
