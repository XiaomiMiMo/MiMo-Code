import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { onMount, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useLanguage } from "@tui/context/language"

export type DialogExportOptionsProps = {
  defaultFilename: string
  defaultThinking: boolean
  defaultToolDetails: boolean
  defaultAssistantMetadata: boolean
  defaultOpenWithoutSaving: boolean
  onConfirm?: (options: {
    filename: string
    thinking: boolean
    toolDetails: boolean
    assistantMetadata: boolean
    openWithoutSaving: boolean
  }) => void
  onCancel?: () => void
}

export function DialogExportOptions(props: DialogExportOptionsProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useLanguage().t
  let textarea: TextareaRenderable
  const [store, setStore] = createStore({
    thinking: props.defaultThinking,
    toolDetails: props.defaultToolDetails,
    assistantMetadata: props.defaultAssistantMetadata,
    openWithoutSaving: props.defaultOpenWithoutSaving,
    active: "filename" as "filename" | "thinking" | "toolDetails" | "assistantMetadata" | "openWithoutSaving",
  })

  useKeyboard((evt) => {
    if (evt.name === "return") {
      props.onConfirm?.({
        filename: textarea.plainText,
        thinking: store.thinking,
        toolDetails: store.toolDetails,
        assistantMetadata: store.assistantMetadata,
        openWithoutSaving: store.openWithoutSaving,
      })
    }
    if (evt.name === "tab") {
      const order: Array<"filename" | "thinking" | "toolDetails" | "assistantMetadata" | "openWithoutSaving"> = [
        "filename",
        "thinking",
        "toolDetails",
        "assistantMetadata",
        "openWithoutSaving",
      ]
      const currentIndex = order.indexOf(store.active)
      const nextIndex = (currentIndex + 1) % order.length
      setStore("active", order[nextIndex])
      evt.preventDefault()
    }
    if (evt.name === "space" || evt.name === " ") {
      if (store.active === "thinking") setStore("thinking", !store.thinking)
      if (store.active === "toolDetails") setStore("toolDetails", !store.toolDetails)
      if (store.active === "assistantMetadata") setStore("assistantMetadata", !store.assistantMetadata)
      if (store.active === "openWithoutSaving") setStore("openWithoutSaving", !store.openWithoutSaving)
      evt.preventDefault()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("tui.dialog.export.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {t("tui.dialog.close_hint")}
        </text>
      </box>
      <box gap={1}>
        <box>
          <text fg={theme.text}>{t("tui.dialog.export.filename")}</text>
        </box>
        <textarea
          onSubmit={() => {
            props.onConfirm?.({
              filename: textarea.plainText,
              thinking: store.thinking,
              toolDetails: store.toolDetails,
              assistantMetadata: store.assistantMetadata,
              openWithoutSaving: store.openWithoutSaving,
            })
          }}
          height={3}
          keyBindings={[{ name: "return", action: "submit" }]}
          ref={(val: TextareaRenderable) => {
            textarea = val
            val.traits = { status: "FILENAME" }
          }}
          initialValue={props.defaultFilename}
          placeholder={t("tui.dialog.export.filename_placeholder")}
          placeholderColor={theme.textMuted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
      </box>
      <box flexDirection="column">
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={store.active === "thinking" ? theme.backgroundElement : undefined}
          onMouseUp={() => setStore("active", "thinking")}
        >
          <text fg={store.active === "thinking" ? theme.primary : theme.textMuted}>
            {store.thinking ? "[x]" : "[ ]"}
          </text>
          <text fg={store.active === "thinking" ? theme.primary : theme.text}>
            {t("tui.dialog.export.include_thinking")}
          </text>
        </box>
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={store.active === "toolDetails" ? theme.backgroundElement : undefined}
          onMouseUp={() => setStore("active", "toolDetails")}
        >
          <text fg={store.active === "toolDetails" ? theme.primary : theme.textMuted}>
            {store.toolDetails ? "[x]" : "[ ]"}
          </text>
          <text fg={store.active === "toolDetails" ? theme.primary : theme.text}>
            {t("tui.dialog.export.include_tool_details")}
          </text>
        </box>
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={store.active === "assistantMetadata" ? theme.backgroundElement : undefined}
          onMouseUp={() => setStore("active", "assistantMetadata")}
        >
          <text fg={store.active === "assistantMetadata" ? theme.primary : theme.textMuted}>
            {store.assistantMetadata ? "[x]" : "[ ]"}
          </text>
          <text fg={store.active === "assistantMetadata" ? theme.primary : theme.text}>
            {t("tui.dialog.export.include_assistant_metadata")}
          </text>
        </box>
        <box
          flexDirection="row"
          gap={2}
          paddingLeft={1}
          backgroundColor={store.active === "openWithoutSaving" ? theme.backgroundElement : undefined}
          onMouseUp={() => setStore("active", "openWithoutSaving")}
        >
          <text fg={store.active === "openWithoutSaving" ? theme.primary : theme.textMuted}>
            {store.openWithoutSaving ? "[x]" : "[ ]"}
          </text>
          <text fg={store.active === "openWithoutSaving" ? theme.primary : theme.text}>
            {t("tui.dialog.export.open_without_saving")}
          </text>
        </box>
      </box>
      <Show when={store.active !== "filename"}>
        <text fg={theme.textMuted} paddingBottom={1}>
          {t("tui.dialog.export.hint.toggle_prefix")} <span style={{ fg: theme.text }}>space</span>{" "}
          {t("tui.dialog.export.hint.toggle_action")}, <span style={{ fg: theme.text }}>return</span>{" "}
          {t("tui.dialog.export.hint.confirm_action")}
        </text>
      </Show>
      <Show when={store.active === "filename"}>
        <text fg={theme.textMuted} paddingBottom={1}>
          {t("tui.dialog.export.hint.toggle_prefix")} <span style={{ fg: theme.text }}>return</span>{" "}
          {t("tui.dialog.export.hint.confirm_action")}, <span style={{ fg: theme.text }}>tab</span>{" "}
          {t("tui.dialog.export.hint.options_action")}
        </text>
      </Show>
    </box>
  )
}

DialogExportOptions.show = (
  dialog: DialogContext,
  defaultFilename: string,
  defaultThinking: boolean,
  defaultToolDetails: boolean,
  defaultAssistantMetadata: boolean,
  defaultOpenWithoutSaving: boolean,
) => {
  return new Promise<{
    filename: string
    thinking: boolean
    toolDetails: boolean
    assistantMetadata: boolean
    openWithoutSaving: boolean
  } | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogExportOptions
          defaultFilename={defaultFilename}
          defaultThinking={defaultThinking}
          defaultToolDetails={defaultToolDetails}
          defaultAssistantMetadata={defaultAssistantMetadata}
          defaultOpenWithoutSaving={defaultOpenWithoutSaving}
          onConfirm={(options) => resolve(options)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
