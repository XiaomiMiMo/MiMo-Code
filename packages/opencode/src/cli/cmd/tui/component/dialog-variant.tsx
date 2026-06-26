import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useLanguage } from "@tui/context/language"

const VARIANT_KEYS: Record<string, string> = {
  low: "tui.dialog.variant.low",
  medium: "tui.dialog.variant.medium",
  high: "tui.dialog.variant.high",
}

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()
  const { t } = useLanguage()

  const options = createMemo(() => {
    return [
      {
        value: "default",
        title: t("tui.dialog.variant.default"),
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(undefined)
        },
      },
      ...local.model.variant.list().map((variant) => ({
        value: variant,
        title: t(VARIANT_KEYS[variant] ?? variant),
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(variant)
        },
      })),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={t("tui.dialog.variant.title")}
      current={local.model.variant.selected()}
      flat={true}
    />
  )
}
