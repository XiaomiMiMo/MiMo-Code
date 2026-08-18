import { createMemo } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useLocal } from "@tui/context/local"
import { useLanguage } from "@tui/context/language"
import { useToast } from "../ui/toast"

const TIERS: (number | null)[] = [null, 30_000, 60_000, 120_000, 300_000, 600_000]

export function DialogPermissionTimeout() {
  const dialog = useDialog()
  const local = useLocal()
  const toast = useToast()
  const t = useLanguage().t

  const options = createMemo(() => {
    const current = local.permissionAskTimeout.current()
    const values =
      current !== null && !TIERS.includes(current) ? [current, ...TIERS] : TIERS
    return values.map((value) => ({
      title: value === null ? t("tui.permission_timeout.option.never") : formatDuration(value),
      value,
      description:
        value === null
          ? t("tui.permission_timeout.option.never_description")
          : t("tui.permission_timeout.option.tier_description", { duration: formatDuration(value) }),
    }))
  })

  return (
    <DialogSelect<number | null>
      title={t("tui.permission_timeout.title")}
      hint={t("tui.permission_timeout.hint")}
      options={options()}
      current={local.permissionAskTimeout.current()}
      onSelect={(option) => {
        local.permissionAskTimeout.set(option.value)
        toast.show({
          variant: "success",
          message:
            option.value === null
              ? t("tui.permission_timeout.toast_never")
              : t("tui.permission_timeout.toast_set", { duration: formatDuration(option.value) }),
          duration: 3000,
        })
        dialog.clear()
      }}
    />
  )
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.round(ms / 60_000)
  return `${minutes}min`
}

DialogPermissionTimeout.show = (dialog: DialogContext) => {
  dialog.replace(() => <DialogPermissionTimeout />)
}
