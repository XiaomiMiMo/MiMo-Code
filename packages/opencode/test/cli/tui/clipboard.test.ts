import { describe, expect, test } from "bun:test"
import { getLinuxCopyCommands, runLinuxCopyCommands } from "../../../src/cli/cmd/tui/util/clipboard"

describe("clipboard", () => {
  test("prefers wl-copy on Wayland before X11 helpers", () => {
    const commands = getLinuxCopyCommands({ WAYLAND_DISPLAY: "wayland-1" }, () => true)

    expect(commands.map((command) => command.name)).toEqual(["wl-copy", "xclip", "xsel"])
  })

  test("uses X11 helpers when Wayland is unavailable", () => {
    const commands = getLinuxCopyCommands({}, (command) => command !== "wl-copy")

    expect(commands.map((command) => command.name)).toEqual(["xclip", "xsel"])
  })

  test("falls back to the next Linux helper after a copy failure", async () => {
    const attempts: string[] = []

    await runLinuxCopyCommands(
      "hello",
      [
        { name: "xclip", command: ["xclip", "-selection", "clipboard"] },
        { name: "xsel", command: ["xsel", "--clipboard", "--input"] },
      ],
      async (command) => {
        attempts.push(command.name)
        if (command.name === "xclip") throw new Error("display unavailable")
      },
    )

    expect(attempts).toEqual(["xclip", "xsel"])
  })

  test("throws an actionable error when no Linux clipboard helper works", async () => {
    await expect(
      runLinuxCopyCommands("hello", [{ name: "xclip", command: ["xclip", "-selection", "clipboard"] }], async () => {
        throw new Error("display unavailable")
      }),
    ).rejects.toThrow("Install wl-clipboard, xclip, or xsel")
  })
})
