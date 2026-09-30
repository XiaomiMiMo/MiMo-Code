import { useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { win32FlushInputBuffer } from "../win32"
type Exit = ((reason?: unknown) => Promise<void>) & {
  message: {
    set: (value?: string) => () => void
    clear: () => void
    get: () => string | undefined
  }
}

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { onBeforeExit?: () => Promise<void>; onExit?: () => Promise<void> }) => {
    const renderer = useRenderer()
    let message: string | undefined
    let task: Promise<void> | undefined
    const store = {
      set: (value?: string) => {
        const prev = message
        message = value
        return () => {
          message = prev
        }
      },
      clear: () => {
        message = undefined
      },
      get: () => message,
    }
    const exit: Exit = Object.assign(
      (reason?: unknown) => {
        if (task) return task
        task = (async () => {
          await input.onBeforeExit?.()
          // Reset window title before destroying renderer
          renderer.setTerminalTitle("")
          renderer.destroy()
          // SGR reset + show cursor + OSC 110/111/112 reset terminal fg/bg/cursor color.
          // Without the OSC resets, whatever fg/bg the active mimocode theme pushed
          // via OSC 10/11/12 would persist in the terminal session, leaving the
          // shell prompt unreadable (e.g. white-on-white).
          process.stdout.write("\x1b[0m\x1b[?25h\x1b]110\x07\x1b]111\x07\x1b]112\x07")
          win32FlushInputBuffer()
          if (reason) {
            const formatted = FormatError(reason) ?? FormatUnknownError(reason)
            if (formatted) {
              process.stderr.write(formatted + "\n")
            }
          }
          const text = store.get()
          if (text) process.stdout.write(text + "\n")
          await input.onExit?.()
        })()
        return task
      },
      {
        message: store,
      },
    )
    process.on("SIGHUP", () => exit())
    return exit
  },
})
