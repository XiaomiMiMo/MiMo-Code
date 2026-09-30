// @ts-nocheck — low-level FFI integration test against opentui internals
import { describe, expect, test } from "bun:test"
import { resolveRenderLib, EditBuffer, EditorView, createExtmarksController } from "@opentui/core"

const lib = await resolveRenderLib()

function setup() {
  const buf = new EditBuffer(lib, lib.createEditBuffer(80, 10))
  const view = new EditorView(lib, lib.createEditorView(buf.bufferPtr, 80, 10))
  const extmarks = createExtmarksController(buf, view)
  const typeId = extmarks.registerType("paste")
  return { buf, view, extmarks, typeId }
}

describe("extmark CJK adjustment (patch)", () => {
  test("insertChar shifts extmark by display width of CJK character", () => {
    const { buf, view, extmarks, typeId } = setup()
    buf.insertText("hello")
    extmarks.create({ start: 5, end: 15, typeId, virtual: true })
    view.setCursorByOffset(0)
    buf.insertChar("中")
    const mark = extmarks.getAll()[0]
    expect(mark.start).toBe(7)
    expect(mark.end).toBe(17)
  })

  test("insertText shifts extmark by total display width", () => {
    const { buf, view, extmarks, typeId } = setup()
    buf.insertText("hello")
    extmarks.create({ start: 5, end: 15, typeId, virtual: true })
    view.setCursorByOffset(0)
    buf.insertText("你好")
    const mark = extmarks.getAll()[0]
    expect(mark.start).toBe(9)
    expect(mark.end).toBe(19)
  })

  test("deleteCharBackward adjusts by display width of deleted CJK char", () => {
    const { buf, view, extmarks, typeId } = setup()
    buf.insertText("中hello")
    extmarks.create({ start: 2, end: 12, typeId, virtual: true })
    view.setCursorByOffset(2)
    buf.deleteCharBackward()
    const mark = extmarks.getAll()[0]
    expect(mark.start).toBe(0)
    expect(mark.end).toBe(10)
  })

  test("deleteChar (forward) adjusts by display width of deleted CJK char", () => {
    const { buf, view, extmarks, typeId } = setup()
    buf.insertText("中hello")
    extmarks.create({ start: 2, end: 12, typeId, virtual: true })
    view.setCursorByOffset(0)
    buf.deleteChar()
    const mark = extmarks.getAll()[0]
    expect(mark.start).toBe(0)
    expect(mark.end).toBe(10)
  })

  test("multiple CJK insertions accumulate correctly", () => {
    const { buf, view, extmarks, typeId } = setup()
    buf.insertText("test")
    extmarks.create({ start: 4, end: 14, typeId, virtual: true })
    view.setCursorByOffset(0)
    buf.insertChar("你")
    buf.insertChar("好")
    buf.insertChar("世")
    const mark = extmarks.getAll()[0]
    expect(mark.start).toBe(10)
    expect(mark.end).toBe(20)
  })

  test("insertText with newlines counts newline as width 1", () => {
    const { buf, view, extmarks, typeId } = setup()
    buf.insertText("hello")
    extmarks.create({ start: 5, end: 15, typeId, virtual: true })
    view.setCursorByOffset(0)
    buf.insertText("你\n好")
    const mark = extmarks.getAll()[0]
    expect(mark.start).toBe(10)
    expect(mark.end).toBe(20)
  })

  test("deleteChar works when cursor is past UTF-16 length but within display width", () => {
    // "中中中" = UTF-16 length 3, display width 6
    // Cursor at offset 4 (before 3rd char): 4 >= 3 in old code would skip adjustment
    const { buf, view, extmarks, typeId } = setup()
    buf.insertText("中中中end")
    extmarks.create({ start: 9, end: 19, typeId, virtual: true })
    view.setCursorByOffset(4)
    buf.deleteChar()
    const mark = extmarks.getAll()[0]
    expect(mark.start).toBe(7)
    expect(mark.end).toBe(17)
  })
})
