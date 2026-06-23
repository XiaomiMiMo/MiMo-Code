import { TextAttributes } from "@opentui/core"
import open from "open"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useDialog, type DialogContext } from "@tui/ui/dialog"

const TOKEN_PLAN_URL = "https://platform.xiaomimimo.com/token-plan"

// Shown once per 24h when the free "mimo-auto" channel hits a rate limit /
// queue ("too many requests"). Modeled on DialogAgreement (same medium width).
export function DialogTokenPlan(props: { onClose?: () => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useLanguage().t

  const close = () => {
    dialog.clear()
    props.onClose?.()
  }

  useKeyboard((evt) => {
    if (evt.name === "return") close()
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
            onMouseUp={() => open(TOKEN_PLAN_URL).catch(() => {})}
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
