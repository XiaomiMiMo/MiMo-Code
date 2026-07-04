import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useLanguage } from "@tui/context/language"

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
        title: variant,
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
      title={t("tui.dialog.variant.select")}
      current={local.model.variant.selected()}
      flat={true}
    />
  )
}
