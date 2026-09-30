import { TextAttributes } from "@opentui/core"
import { createMemo } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useLanguage } from "@tui/context/language"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import * as Model from "@tui/util/model"
import { Token } from "@/util"

const TIERS = [200_000, 300_000, 500_000, 1_000_000]

type Choice = number | "default" | "custom"

export function DialogContextLimit() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const toast = useToast()
  const { theme } = useTheme()
  const t = useLanguage().t

  const selected = local.model.current()
  const win = createMemo(() =>
    selected
      ? Model.contextWindow(sync.data.config, Model.get(sync.data.provider, selected.providerID, selected.modelID))
      : undefined,
  )

  async function save(value: number | undefined) {
    if (!selected) return
    const current = win()
    const key = `${selected.providerID}/${selected.modelID}`
    const reserves = current ? current.effective - current.usable : 0
    if (value !== undefined && current && value >= current.hard) {
      toast.show({
        variant: "error",
        message: t("tui.context_limit.too_large", { window: Token.format(current.hard) }),
        duration: 4000,
      })
      return
    }
    if (value !== undefined && value <= reserves) {
      toast.show({
        variant: "error",
        message: t("tui.context_limit.too_small", { reserved: Token.format(reserves) }),
        duration: 4000,
      })
      return
    }

    // A config write disposes the instance, which cancels every in-flight runner, so
    // refuse while any session is working. session_status is the server's own view,
    // unlike the message-derived status which can stay "working" after a crash.
    if (Object.values(sync.data.session_status).some((status) => status.type !== "idle")) {
      toast.show({ variant: "error", message: t("tui.context_limit.busy"), duration: 4000 })
      return
    }

    // Write only this model's key: both config writers patch leaf paths, so sibling
    // entries survive. Reading the merged config instead would promote project-level
    // budgets into the user's global file.
    // The generated SDK config type lags the server schema for this field; regenerating
    // it is blocked by a pre-existing dangling $ref in the OpenAPI output.
    const existing = (sync.data.config.compaction as { max_context?: unknown } | undefined)?.max_context
    if (existing !== undefined && typeof existing !== "object") {
      toast.show({ variant: "error", message: t("tui.context_limit.scalar_config"), duration: 6000 })
      return
    }
    const res = await sdk.client.global.config.update({
      // 0 restores the model default: a config merge cannot delete a key.
      config: { compaction: { max_context: { [key]: value ?? 0 } } } as never,
    })
    if (res.error) {
      toast.show({ variant: "error", message: JSON.stringify(res.error) })
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.clear()

    // The write lands in the user-global config, but everything reads the merged one and
    // project config wins per key. Re-resolve and say so rather than claiming success on
    // a value that a project mimocode.json shadows.
    const applied = Model.contextWindow(
      sync.data.config,
      Model.get(sync.data.provider, selected.providerID, selected.modelID),
    )
    if (applied && applied.effective !== (value ?? applied.hard)) {
      toast.show({
        variant: "error",
        message: t("tui.context_limit.shadowed", { value: Token.format(applied.effective) }),
        duration: 6000,
      })
      return
    }
    toast.show({
      variant: "success",
      message:
        value === undefined
          ? t("tui.context_limit.cleared", { model: key })
          : t("tui.context_limit.saved", { model: key, value: Token.format(value - reserves) }),
      duration: 3000,
    })
  }

  if (!selected || !win()) {
    toast.show({ variant: "error", message: t("tui.context_limit.no_model"), duration: 3000 })
    dialog.clear()
    return <></>
  }

  const options = createMemo(() => {
    const current = win()!
    // Reserves are the gap between the window in force and the trigger — deriving them
    // from `hard` would double-count an already active budget.
    const reserves = current.effective - current.usable
    return [
      {
        title: t("tui.context_limit.option.default", { value: Token.format(current.hard) }),
        value: "default" as Choice,
        description: t("tui.context_limit.option.default_description"),
      },
      ...TIERS.filter((tier) => tier < current.hard).map((tier) => ({
        title: Token.format(tier),
        value: tier as Choice,
        description: t("tui.context_limit.option.tier_description", {
          value: Token.format(Math.max(0, tier - reserves)),
        }),
      })),
      {
        title: t("tui.context_limit.option.custom"),
        value: "custom" as Choice,
        description: t("tui.context_limit.option.custom_description"),
      },
    ]
  })

  return (
    <DialogSelect<Choice>
      title={t("tui.context_limit.title", { model: `${selected.providerID}/${selected.modelID}` })}
      hint={t("tui.context_limit.hint", {
        window: Token.format(win()!.hard),
        compact: Token.format(win()!.usable),
      })}
      options={options()}
      current={win()!.source === "config" ? win()!.effective : "default"}
      onSelect={(option) => {
        if (option.value === "custom") {
          dialog.replace(() => (
            <DialogPrompt
              title={t("tui.context_limit.custom_title")}
              placeholder="300K"
              description={() => (
                <text fg={theme.textMuted} attributes={TextAttributes.NONE}>
                  {t("tui.context_limit.custom_description", { window: Token.format(win()!.hard) })}
                </text>
              )}
              onConfirm={(raw) => {
                const parsed = Token.parseQuantity(raw, win()!.hard)
                if (parsed === undefined) {
                  toast.show({ variant: "error", message: t("tui.context_limit.invalid", { value: raw }) })
                  return
                }
                void save(parsed)
              }}
              onCancel={() => dialog.clear()}
            />
          ))
          return
        }
        void save(option.value === "default" ? undefined : option.value)
      }}
    />
  )
}

DialogContextLimit.show = (dialog: DialogContext) => {
  dialog.replace(() => <DialogContextLimit />)
}
