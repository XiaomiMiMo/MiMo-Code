import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useLocal } from "@tui/context/local"
import { useLanguage } from "@tui/context/language"
import { useToast } from "../ui/toast"

const TIERS: { label: string; value: number | null }[] = [
  { label: "Never", value: null },
  { label: "30 seconds", value: 30_000 },
  { label: "1 minute", value: 60_000 },
  { label: "2 minutes", value: 120_000 },
  { label: "5 minutes", value: 300_000 },
  { label: "10 minutes", value: 600_000 },
]

export function DialogPermissionTimeout() {
  const dialog = useDialog()
  const local = useLocal()
  const toast = useToast()
  const t = useLanguage().t

  const options = TIERS.map((tier) => ({
    title: tier.value === null ? t("tui.permission_timeout.option.never") : formatDuration(tier.value),
    value: tier.value,
    description:
      tier.value === null
        ? t("tui.permission_timeout.option.never_description")
        : t("tui.permission_timeout.option.tier_description", { duration: formatDuration(tier.value) }),
  }))

  return (
    <DialogSelect<number | null>
      title={t("tui.permission_timeout.title")}
      hint={t("tui.permission_timeout.hint")}
      options={options}
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
