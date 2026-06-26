import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import { useKeybind } from "../context/keybind"
import { useSDK } from "../context/sdk"
import { useToast, type ToastContext } from "../ui/toast"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useLanguage } from "@tui/context/language"
import * as fuzzysort from "fuzzysort"

const ADD_MODEL_SENTINEL = "__add_model__"

export function useConnected() {
  const sync = useSync()
  return createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
}

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const keybind = useKeybind()
  const t = useLanguage().t
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((x) => x.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? t("tui.dialog.model.free_label") : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, t("tui.dialog.model.favorites"))
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      t("tui.dialog.model.recent"),
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) => {
        const models = pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "opencode" ? t("tui.dialog.model.free_label") : undefined,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          filter((x) => {
            if (!showSections) return true
            if (favorites.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            if (recents.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            return true
          }),
          sortBy(
            (x) => x.footer !== t("tui.dialog.model.free_label"),
            (x) => x.title,
          ),
        )
        if (props.providerID && props.providerID !== provider.id) return models
        return [
          ...models,
          {
            value: { providerID: provider.id, modelID: ADD_MODEL_SENTINEL },
            title: t("tui.dialog.model.add_model"),
            description: undefined,
            category: connected() ? provider.name : undefined,
            disabled: false,
            footer: undefined as "Free" | undefined,
            onSelect() {
              void runAddModelWizard({ dialog, sdk, sync, toast, providerID: provider.id, t })
            },
          },
        ]
      }),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: t("tui.dialog.model.popular_providers"),
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((x) => x.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return t("tui.dialog.model.select_model")
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      keybind={[
        {
          keybind: keybind.all.model_provider_list?.[0],
          title: connected() ? t("tui.dialog.model.connect_provider") : t("tui.dialog.model.view_all_providers"),
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          keybind: keybind.all.model_favorite_toggle?.[0],
          title: t("tui.dialog.model.favorite"),
          disabled: !connected(),
          onTrigger: (option) => {
            const v = option.value as { providerID: string; modelID: string }
            if (v.modelID === ADD_MODEL_SENTINEL) return
            local.model.toggleFavorite(v)
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

async function runAddModelWizard(opts: {
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ToastContext
  t: ReturnType<typeof useLanguage>["t"]
  providerID: string
}) {
  const { dialog, sdk, sync, toast, t, providerID } = opts

  function step(n: number, total: number, title: string, placeholder?: string, value?: string) {
    return DialogPrompt.show(dialog, `${title} (${n}/${total})`, { placeholder, value })
  }

  const modelIDRaw = await step(1, 2, t("tui.dialog.model.add_wizard.model_id"), t("tui.dialog.model.add_wizard.model_id_placeholder"))
  if (modelIDRaw === null) return
  const modelID = modelIDRaw.trim()
  if (!modelID) return

  const modelNameRaw = await step(2, 2, t("tui.dialog.model.add_wizard.display_name"), t("tui.dialog.model.add_wizard.display_name_placeholder"), modelID)
  if (modelNameRaw === null) return
  const modelName = modelNameRaw.trim() || modelID

  const patch = {
    provider: {
      [providerID]: {
        models: {
          [modelID]: {
            name: modelName,
          },
        },
      },
    },
  }

  const updateRes = await sdk.client.global.config.update({ config: patch as any })
  if (updateRes.error) {
    toast.show({ variant: "error", message: JSON.stringify(updateRes.error) })
    return
  }

  await sdk.client.instance.dispose()
  await sync.bootstrap()
  dialog.replace(() => <DialogModel providerID={providerID} />)
}
