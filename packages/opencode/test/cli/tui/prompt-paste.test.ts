import { describe, expect, test } from "bun:test"
import { pasteClipboardContent } from "../../../src/cli/cmd/tui/component/prompt/paste"

describe("prompt clipboard paste", () => {
  test("pastes plain text from clipboard content", async () => {
    const pasted: string[] = []
    const attachments: unknown[] = []

    const handled = await pasteClipboardContent({
      content: { data: "hello\r\nworld", mime: "text/plain" },
      pasteText: async (text) => {
        pasted.push(text)
      },
      pasteAttachment: async (file) => {
        attachments.push(file)
      },
    })

    expect(handled).toBe(true)
    expect(pasted).toEqual(["hello\nworld"])
    expect(attachments).toEqual([])
  })

  test("pastes images as clipboard attachments", async () => {
    const pasted: string[] = []
    const attachments: unknown[] = []

    const handled = await pasteClipboardContent({
      content: { data: "base64", mime: "image/png" },
      pasteText: async (text) => {
        pasted.push(text)
      },
      pasteAttachment: async (file) => {
        attachments.push(file)
      },
    })

    expect(handled).toBe(true)
    expect(pasted).toEqual([])
    expect(attachments).toEqual([{ filename: "clipboard", content: "base64", mime: "image/png" }])
  })

  test("does not handle empty clipboard content", async () => {
    const handled = await pasteClipboardContent({
      content: undefined,
      pasteText: async () => {},
      pasteAttachment: async () => {},
    })

    expect(handled).toBe(false)
  })
})
