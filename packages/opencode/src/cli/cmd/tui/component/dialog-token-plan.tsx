import { TextAttributes } from "@opentui/core"
import open from "open"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useToast } from "@tui/ui/toast"
import * as Clipboard from "@tui/util/clipboard"
import { useDialog, type DialogContext } from "@tui/ui/dialog"

const TOKEN_PLAN_URL = "https://platform.xiaomimimo.com/token-plan"

// Shown once per 24h when the free "mimo-auto" channel hits a rate limit /
// queue ("too many requests"). Modeled on DialogAgreement (same medium width).
export function DialogTokenPlan(props: { onClose?: () => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useLanguage().t
  const toast = useToast()

  const close = () => {
    dialog.clear()
    props.onClose?.()
  }

  const openLink = () => {
    open(TOKEN_PLAN_URL).catch(() => {
      Clipboard.copy(TOKEN_PLAN_URL).catch(() => {})
      toast.show({ message: TOKEN_PLAN_URL, variant: "info" })
    })
  }

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") close()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("tui.dialog.token_plan.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => close()}>
          {t("tui.dialog.close_hint")}
        </text>
      </box>
      <box gap={0} paddingBottom={1}>
        <text fg={theme.textMuted}>{t("tui.dialog.token_plan.line1")}</text>
        <box flexDirection="row" flexWrap="wrap">
          <text fg={theme.textMuted}>{t("tui.dialog.token_plan.subscribe")}</text>
          <text
            fg={theme.primary}
            attributes={TextAttributes.UNDERLINE}
            onMouseUp={() => openLink()}
          >
            {t("tui.dialog.token_plan.link")}
          </text>
          <text fg={theme.textMuted}>{t("tui.dialog.token_plan.link_suffix")}</text>
        </box>
        <text fg={theme.textMuted}>{t("tui.dialog.token_plan.line3")}</text>
      </box>
      <box flexDirection="row" justifyContent="center" paddingBottom={1}>
        <box paddingLeft={2} paddingRight={2} backgroundColor={theme.primary} onMouseUp={() => close()}>
          <text fg={theme.selectedListItemText}>{t("tui.dialog.token_plan.confirm")}</text>
        </box>
      </box>
    </box>
  )
}

DialogTokenPlan.show = (dialog: DialogContext) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogTokenPlan onClose={() => resolve()} />,
      () => resolve(),
    )
  })
}
