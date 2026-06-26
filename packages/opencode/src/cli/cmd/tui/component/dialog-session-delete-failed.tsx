import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useLanguage } from "@tui/context/language"

export function DialogSessionDeleteFailed(props: {
  session: string
  workspace: string
  onDelete?: () => boolean | void | Promise<boolean | void>
  onRestore?: () => boolean | void | Promise<boolean | void>
  onDone?: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const { t } = useLanguage()
  const [store, setStore] = createStore({
    active: "delete" as "delete" | "restore",
  })

  const options = [
    {
      id: "delete" as const,
      title: t("tui.dialog.delete_failed.delete_workspace"),
      description: t("tui.dialog.delete_failed.delete_workspace_desc"),
      run: props.onDelete,
    },
    {
      id: "restore" as const,
      title: t("tui.dialog.delete_failed.restore"),
      description: t("tui.dialog.delete_failed.restore_desc"),
      run: props.onRestore,
    },
  ]

  async function confirm() {
    const result = await options.find((item) => item.id === store.active)?.run?.()
    if (result === false) return
    props.onDone?.()
    if (!props.onDone) dialog.clear()
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      void confirm()
    }
    if (evt.name === "left" || evt.name === "up") {
      setStore("active", "delete")
    }
    if (evt.name === "right" || evt.name === "down") {
      setStore("active", "restore")
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("tui.dialog.delete_failed.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {t("tui.dialog.close_hint")}
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {t("tui.dialog.delete_failed.desc", { session: props.session, workspace: props.workspace })}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {t("tui.dialog.delete_failed.hint")}
      </text>
      <box flexDirection="column" paddingBottom={1} gap={1}>
        <For each={options}>
          {(item) => (
            <box
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={item.id === store.active ? theme.primary : undefined}
              onMouseUp={() => {
                setStore("active", item.id)
                void confirm()
              }}
            >
              <text
                attributes={TextAttributes.BOLD}
                fg={item.id === store.active ? theme.selectedListItemText : theme.text}
              >
                {item.title}
              </text>
              <text fg={item.id === store.active ? theme.selectedListItemText : theme.textMuted} wrapMode="word">
                {item.description}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
