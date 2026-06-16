import { TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { Show } from "solid-js"
import open from "open"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useDialog, type DialogContext } from "@tui/ui/dialog"

export const FREE_AGREEMENT_KEY = "free_agreement_accepted"

// Model IDs that count as "free" and require the one-time agreement.
export const FREE_MODEL_IDS = new Set(["mimo-auto", "mimo-free"])

const TERMS_URL = "https://platform.xiaomimimo.com/docs/terms/user-agreement"
const PRIVACY_URL = "https://privacy.mi.com/XiaomiMiMoPlatform"

export function DialogAgreement(props: { onConfirm?: () => void; onCancel?: () => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useLanguage().t
  const [store, setStore] = createStore({
    active: "confirm" as "confirm" | "cancel",
  })

  const confirm = () => {
    dialog.clear()
    props.onConfirm?.()
  }
  const cancel = () => {
    dialog.clear()
    props.onCancel?.()
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      if (store.active === "confirm") confirm()
      else cancel()
      return
    }
    if (evt.name === "left" || evt.name === "right") {
      setStore("active", store.active === "confirm" ? "cancel" : "confirm")
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("tui.dialog.agreement.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => cancel()}>
          {t("tui.dialog.close_hint")}
        </text>
      </box>
      <box flexDirection="row" flexWrap="wrap">
        <text fg={theme.textMuted}>{t("tui.home.agreement.prefix")}</text>
        <text
          fg={theme.primary}
          attributes={TextAttributes.UNDERLINE}
          onMouseUp={() => open(TERMS_URL).catch(() => {})}
        >
          {t("tui.home.agreement.terms")}
        </text>
        <text fg={theme.textMuted}>{t("tui.home.agreement.separator")}</text>
        <text
          fg={theme.primary}
          attributes={TextAttributes.UNDERLINE}
          onMouseUp={() => open(PRIVACY_URL).catch(() => {})}
        >
          {t("tui.home.agreement.privacy")}
        </text>
        <Show when={t("tui.home.agreement.suffix")}>
          <text fg={theme.textMuted}>{t("tui.home.agreement.suffix")}</text>
        </Show>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{t("tui.dialog.agreement.message")}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={store.active === "cancel" ? theme.primary : undefined}
          onMouseUp={() => cancel()}
        >
          <text fg={store.active === "cancel" ? theme.selectedListItemText : theme.textMuted}>
            {t("tui.dialog.confirm.cancel")}
          </text>
        </box>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={store.active === "confirm" ? theme.primary : undefined}
          onMouseUp={() => confirm()}
        >
          <text fg={store.active === "confirm" ? theme.selectedListItemText : theme.textMuted}>
            {t("tui.dialog.agreement.confirm")}
          </text>
        </box>
      </box>
    </box>
  )
}

DialogAgreement.show = (
  dialog: DialogContext,
  options: { onConfirm: () => void; onClose?: () => void },
) => {
  dialog.replace(() => <DialogAgreement onConfirm={options.onConfirm} />, options.onClose)
}
