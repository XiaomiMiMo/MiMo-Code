import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useKV } from "../context/kv"
import { useLanguage } from "../context/language"
import { logos } from "@/cli/logo"
import { onCleanup } from "solid-js"

export function DialogLogoDesign() {
  const dialog = useDialog()
  const kv = useKV()
  const { t } = useLanguage()
  const initial = kv.get("logo_design")
  let confirmed = false

  onCleanup(() => {
    if (!confirmed) kv.set("logo_design", initial)
  })

  const options: DialogSelectOption<string>[] = Object.keys(logos).map((key) => ({
    title: t(`tui.dialog.logo.option.${key}`),
    value: key,
  }))

  return (
    <DialogSelect
      title={t("tui.dialog.logo.title")}
      options={options}
      current={typeof initial === "string" ? initial : "thin"}
      onMove={(opt) => kv.set("logo_design", opt.value)}
      onSelect={(opt) => {
        kv.set("logo_design", opt.value)
        confirmed = true
        dialog.clear()
      }}
    />
  )
}
