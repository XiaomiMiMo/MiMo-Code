import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import * as Clipboard from "../../../../src/cli/cmd/tui/util/clipboard"

describe("clipboard", () => {
  test("rejects when the clipboard process has no stdin", async () => {
    const err = await Clipboard.writeClipboardProcess("powershell", { exited: Promise.resolve(0) }, "copied").catch(
      (error) => error,
    )

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("stdin")
  })

  test("rejects when the clipboard process exits with a non-zero code", async () => {
    const stdin = new PassThrough()
    stdin.resume()

    const err = await Clipboard.writeClipboardProcess(
      "powershell",
      { stdin, exited: Promise.resolve(7) },
      "copied",
    ).catch((error) => error)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("7")
  })

  test("writes clipboard text to process stdin", async () => {
    const stdin = new PassThrough()
    const chunks: Buffer[] = []
    stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)))

    await Clipboard.writeClipboardProcess("powershell", { stdin, exited: Promise.resolve(0) }, "copied")

    expect(Buffer.concat(chunks).toString()).toBe("copied")
  })
})
