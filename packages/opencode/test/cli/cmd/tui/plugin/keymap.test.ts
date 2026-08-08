import { describe, expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { createPluginKeymap } from "../../../../../src/cli/cmd/tui/plugin/keymap"

type MockOption = {
  title: string
  value: string
  enabled?: boolean
  onSelect?: (dialog: unknown) => void
}

type Input = Parameters<typeof createPluginKeymap>[0]

function mockCommandDialog() {
  const registrations: (() => MockOption[])[] = []
  const shown: number[] = []
  const command = {
    register(cb: () => MockOption[]) {
      registrations.push(cb)
      return () => {
        const index = registrations.indexOf(cb)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
    find(name: string) {
      for (const reg of registrations) {
        for (const option of reg()) {
          if (option.value === name) return option
        }
      }
      return undefined
    },
    trigger() {},
    show() {
      shown.push(shown.length + 1)
    },
  }
  return {
    command,
    shown,
    options() {
      return registrations.flatMap((reg) => reg())
    },
  }
}

function makeKeymap() {
  const mock = mockCommandDialog()
  const keymap = createPluginKeymap({
    command: mock.command as unknown as Input["command"],
    keybind: {} as unknown as Input["keybind"],
    dialog: {} as unknown as Input["dialog"],
  })
  return { keymap, mock }
}

describe("createPluginKeymap", () => {
  test("registerLayer registers command options with title/value/slash", () => {
    const { keymap, mock } = makeKeymap()
    const dispose = keymap.registerLayer({
      commands: [
        {
          name: "quota.show",
          title: "Show quota",
          desc: "Shows usage",
          category: "OpenCode Quota",
          slashName: "quota",
          run: () => {},
        },
      ],
      bindings: [],
    })

    expect(keymap.getCommands()).toHaveLength(1)
    expect(mock.options()[0]).toMatchObject({
      title: "Show quota",
      value: "quota.show",
      description: "Shows usage",
      category: "OpenCode Quota",
      slash: { name: "quota" },
    })

    dispose()
    expect(keymap.getCommands()).toHaveLength(0)
  })

  test("dispatchCommand runs the command and returns ok", () => {
    const { keymap, mock } = makeKeymap()
    const ran: unknown[] = []
    keymap.registerLayer({
      commands: [{ name: "hello", run(ctx) { ran.push(ctx) } }],
      bindings: [],
    })

    const result = keymap.dispatchCommand("hello")

    expect(result).toMatchObject({ ok: true, command: { name: "hello" } })
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatchObject({ input: "hello", command: { name: "hello" } })
    expect(mock.shown).toHaveLength(0)
  })

  test("dispatchCommand(command.palette.show) opens the dialog", () => {
    const { keymap, mock } = makeKeymap()
    expect(keymap.dispatchCommand("command.palette.show")).toEqual({ ok: true })
    expect(mock.shown).toHaveLength(1)
  })

  test("dispatchCommand returns not-found for unknown commands", () => {
    const { keymap } = makeKeymap()
    expect(keymap.dispatchCommand("unknown.command")).toEqual({ ok: false, reason: "not-found" })
  })

  test("dispatchCommand respects the enabled gate", () => {
    const { keymap } = makeKeymap()
    const ran: string[] = []
    keymap.registerLayer({
      commands: [{ name: "hidden", enabled: false, run() { ran.push("hidden") } }],
      bindings: [],
    })

    expect(keymap.dispatchCommand("hidden")).toEqual({ ok: false, reason: "disabled" })
    expect(ran).toHaveLength(0)
  })

  test("setData/getData round-trip and ctx.data reflects the store", () => {
    const { keymap } = makeKeymap()
    const ctxs: Record<string, unknown>[] = []
    keymap.setData("token", "abc")
    keymap.registerLayer({
      commands: [{ name: "read", run(ctx) { ctxs.push(ctx as Record<string, unknown>) } }],
      bindings: [],
    })

    keymap.dispatchCommand("read")

    expect(keymap.getData("token")).toBe("abc")
    expect(ctxs[0].data).toEqual({ token: "abc" })
  })

  test("dispatchCommand threads payload and event through the context", () => {
    const { keymap } = makeKeymap()
    const ctxs: Record<string, unknown>[] = []
    keymap.registerLayer({
      commands: [{ name: "echo", run(ctx) { ctxs.push(ctx as Record<string, unknown>) } }],
      bindings: [],
    })

    const event = { name: "x" } as unknown as KeyEvent
    keymap.dispatchCommand("echo", { payload: 42, event })

    expect(ctxs[0].payload).toBe(42)
    expect(ctxs[0].event).toBe(event)
  })

  test("function-valued bindings fire via their synthetic command name", () => {
    const { keymap, mock } = makeKeymap()
    const ran: unknown[] = []
    keymap.registerLayer({
      commands: [],
      bindings: [{ key: "ctrl+x", cmd(ctx) { ran.push(ctx) } }],
    })

    // function bindings are hidden keybind options, not palette commands
    expect(keymap.getCommands()).toHaveLength(0)
    expect(keymap.getCommandBindings().size).toBe(0)
    expect(mock.options()[0]).toMatchObject({ value: "__keybind:ctrl+x:0", hidden: true })

    const result = keymap.dispatchCommand("__keybind:ctrl+x:0")
    expect(result).toEqual({ ok: true })
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatchObject({ input: "__keybind:ctrl+x:0", command: undefined })
  })
})
