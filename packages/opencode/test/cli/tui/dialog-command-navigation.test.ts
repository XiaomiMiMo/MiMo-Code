import { describe, expect, test } from "bun:test"
import { handleCommandListKey, withCommandPaletteBack } from "../../../src/cli/cmd/tui/component/dialog-command"
import type { DialogContext } from "../../../src/cli/cmd/tui/ui/dialog"

describe("command dialog navigation", () => {
  test("opens the command palette even when the focused input already handled Ctrl+P", () => {
    let shown = false
    let prevented = false
    const event = {
      defaultPrevented: true,
      preventDefault: () => {
        prevented = true
      },
    } as unknown as Parameters<typeof handleCommandListKey>[0]

    const handled = handleCommandListKey(
      event,
      { match: (key: string) => key === "command_list" },
      () => {
        shown = true
      },
    )

    expect(handled).toBe(true)
    expect(prevented).toBe(true)
    expect(shown).toBe(true)
  })

  test("opens nested command palette dialogs on top so Escape can return to the palette", () => {
    const calls: string[] = []
    const dialog = {
      clear: () => calls.push("clear"),
      replace: () => calls.push("replace"),
      push: () => calls.push("push"),
      get stack() {
        return []
      },
      get size() {
        return "medium" as const
      },
      setSize: () => {},
    } satisfies DialogContext
    const options = withCommandPaletteBack(
      [
        {
          title: "Models",
          value: "model.list",
          onSelect: (dialog) => dialog.replace(() => "model-dialog"),
        },
      ],
      dialog,
    )

    options[0].onSelect?.()

    expect(calls).toEqual(["push"])
  })
})
