import { describe, expect, test } from "bun:test"
import { linuxClipboardReadCommands, linuxClipboardWriteCommands } from "../../src/cli/cmd/tui/util/clipboard"

function which(...names: string[]) {
  return (cmd: string) => (names.includes(cmd) ? `/bin/${cmd}` : null)
}

describe("tui clipboard", () => {
  test("uses the CLIPBOARD selection for X11 reads and writes", () => {
    expect(linuxClipboardReadCommands({}, which("xclip", "xsel"))).toEqual([
      { name: "xclip", args: ["xclip", "-selection", "clipboard", "-o"] },
      { name: "xsel", args: ["xsel", "--clipboard", "--output"] },
    ])
    expect(linuxClipboardWriteCommands({}, which("xclip", "xsel"))).toEqual([
      { name: "xclip", args: ["xclip", "-selection", "clipboard"] },
      { name: "xsel", args: ["xsel", "--clipboard", "--input"] },
    ])
  })

  test("prefers Wayland helpers when Wayland is active", () => {
    const env = { WAYLAND_DISPLAY: "wayland-0" }

    expect(linuxClipboardReadCommands(env, which("wl-paste", "xclip"))).toEqual([
      { name: "wl-paste", args: ["wl-paste", "--no-newline"] },
      { name: "xclip", args: ["xclip", "-selection", "clipboard", "-o"] },
    ])
    expect(linuxClipboardWriteCommands(env, which("wl-copy", "xclip"))).toEqual([
      { name: "wl-copy", args: ["wl-copy"] },
      { name: "xclip", args: ["xclip", "-selection", "clipboard"] },
    ])
  })

  test("omits unavailable native helpers", () => {
    expect(linuxClipboardReadCommands({}, which())).toEqual([])
    expect(linuxClipboardWriteCommands({}, which())).toEqual([])
  })
})
