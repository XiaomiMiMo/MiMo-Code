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
import * as Model from "../util/model"
import { PROVIDER_PRIORITY } from "@/util/provider-priority"
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
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()
  const t = useLanguage().t
  const providerName = (p: { id: string; name: string }) => t("provider.name." + p.id) || p.name
  const modelName = (providerID: string, modelID: string) =>
    modelID === "mimo-auto" ? t("tui.model.mimo_auto.name") : Model.name(sync.data.provider, providerID, modelID)

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()
    // A model already shown in the Favorites/Recent shortcut sections must not
    // appear again in its provider group (show each model at most once).
    const inShortcuts = (providerID: string, modelID: string) =>
      favorites.some((item) => item.providerID === providerID && item.modelID === modelID) ||
      recents.some((item) => item.providerID === providerID && item.modelID === modelID)

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
            title: modelName(provider.id, model.id),
            description: providerName(provider),
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => PROVIDER_PRIORITY[provider.id] ?? 99,
        (provider) => providerName(provider),
      ),
      flatMap((provider) => {
        // The free mimo-auto model is surfaced as the top entry of the Xiaomi
        // group below, so the mimo provider never renders its own section.
        if (provider.id === "mimo") return []
        const models = pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            description: undefined as string | undefined,
            category: connected() ? providerName(provider) : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          // Favorites/recents live in their own sections; don't repeat them here.
          filter((x) => {
            if (!showSections) return true
            return !inShortcuts(x.value.providerID, x.value.modelID)
          }),
          sortBy(
            (x) => x.footer !== "Free",
            (x) => x.title,
          ),
        )
        // Prepend the free mimo-auto model to the Xiaomi group when it's loaded
        // and not already surfaced in the Favorites/Recent sections.
        const free =
          provider.id === "xiaomi" &&
          (!props.providerID || props.providerID === provider.id) &&
          (!showSections || !inShortcuts("mimo", "mimo-auto")) &&
          sync.data.provider.some((p) => p.id === "mimo" && "mimo-auto" in p.models)
            ? [
                {
                  value: { providerID: "mimo", modelID: "mimo-auto" },
                  title: modelName("mimo", "mimo-auto"),
                  description: undefined as string | undefined,
                  category: connected() ? providerName(provider) : undefined,
                  disabled: false,
                  footer: undefined as "Free" | undefined,
                  onSelect() {
                    onSelect("mimo", "mimo-auto")
                  },
                },
              ]
            : []
        if (provider.source !== "config") return [...free, ...models]
        if (props.providerID && props.providerID !== provider.id) return [...free, ...models]
        return [
          ...free,
          ...models,
          {
            value: { providerID: provider.id, modelID: ADD_MODEL_SENTINEL },
            title: "+ Add model",
            description: undefined,
            category: connected() ? providerName(provider) : undefined,
            disabled: false,
            footer: undefined as "Free" | undefined,
            onSelect() {
              void runAddModelWizard({ dialog, sdk, sync, toast, providerID: provider.id })
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
            category: "Popular providers",
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
    if (!value) return "Select model"
    return providerName(value)
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
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          keybind: keybind.all.model_favorite_toggle?.[0],
          title: "Favorite",
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
      title={title()}
      hint={t("tui.dialog.model.login_hint")}
      current={local.model.current()}
    />
  )
}

async function runAddModelWizard(opts: {
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ToastContext
  providerID: string
}) {
  const { dialog, sdk, sync, toast, providerID } = opts

  function step(n: number, total: number, title: string, placeholder?: string, value?: string) {
    return DialogPrompt.show(dialog, `${title} (${n}/${total})`, { placeholder, value })
  }

  const modelIDRaw = await step(1, 2, "Model id", "gateway model id")
  if (modelIDRaw === null) return
  const modelID = modelIDRaw.trim()
  if (!modelID) return

  const modelNameRaw = await step(2, 2, "Display name", "shown in model picker", modelID)
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
