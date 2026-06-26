import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useLanguage } from "@tui/context/language"
import { createSignal, For, onMount, Show } from "solid-js"
import { Log } from "@/util"
import { Global } from "@/global"
import fs from "fs/promises"

const TAIL_LINES = 100

export function DialogLog() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const t = useLanguage().t
  const [lines, setLines] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()

  const logFile = Log.file()
  const displayPath = logFile?.replace(Global.Path.home, "~") ?? ""

  onMount(async () => {
    if (!logFile) {
      setError(t("tui.dialog.log.no_file"))
      setLoading(false)
      return
    }
    try {
      const content = await fs.readFile(logFile, "utf-8")
      const allLines = content.split("\n").filter(Boolean)
      setLines(allLines.slice(-TAIL_LINES))
    } catch {
      setError(t("tui.dialog.log.read_error"))
    } finally {
      setLoading(false)
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {t("tui.dialog.log.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>{displayPath}</text>
      <Show
        when={!loading()}
        fallback={<text fg={theme.textMuted}>{t("tui.dialog.log.loading")}</text>}
      >
        <Show
          when={!error()}
          fallback={<text fg={theme.error}>{error()}</text>}
        >
          <box flexDirection="column" overflow="hidden">
            <For each={lines()}>
              {(line) => (
                <text fg={theme.text} wrapMode="word">
                  {line}
                </text>
              )}
            </For>
          </box>
        </Show>
      </Show>
    </box>
  )
}
