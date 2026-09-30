import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { createStore } from "solid-js/store"
import { For, onMount } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useLanguage } from "@tui/context/language"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { useToast } from "../ui/toast"

const MODALITIES = ["image", "audio", "video", "pdf"] as const
type Modality = (typeof MODALITIES)[number]

export function DialogModalities() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useLanguage().t
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const toast = useToast()

  const current = local.model.current()
  const provider = current ? sync.data.provider.find((p) => p.id === current.providerID) : undefined
  const model = provider && current ? provider.models[current.modelID] : undefined

  const initialState = MODALITIES.reduce(
    (acc, m) => {
      acc[m] = model?.capabilities?.input?.[m] ?? false
      return acc
    },
    {} as Record<Modality, boolean>,
  )

  const [store, setStore] = createStore({
    ...initialState,
    active: 0,
  })

  onMount(() => {
    dialog.setSize("medium")
  })

  useKeyboard((evt) => {
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      setStore("active", (store.active - 1 + MODALITIES.length) % MODALITIES.length)
      evt.preventDefault()
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      setStore("active", (store.active + 1) % MODALITIES.length)
      evt.preventDefault()
    }
    if (evt.name === "space" || evt.name === " ") {
      const modality = MODALITIES[store.active]
      setStore(modality, !store[modality])
      evt.preventDefault()
    }
    if (evt.name === "return") {
      void save()
      evt.preventDefault()
    }
  })

  async function save() {
    if (!current) return
    const input = ["text" as const, ...MODALITIES.filter((m) => store[m])]
    const output = (["text", "audio", "image", "video", "pdf"] as const).filter(
      (m) => model?.capabilities?.output?.[m],
    )
    const patch = {
      provider: {
        [current.providerID]: {
          models: {
            [current.modelID]: {
              modalities: { input, output },
            },
          },
        },
      },
    }
    const res = await sdk.client.global.config.update({ config: patch as any })
    if (res.error) {
      toast.show({ variant: "error", message: JSON.stringify(res.error) })
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.clear()
    toast.show({
      variant: "success",
      message: t("tui.modalities.saved", { modalities: input.join(", ") }),
      duration: 3000,
    })
  }

  if (!current || !model) {
    toast.show({ variant: "error", message: t("tui.modalities.no_model"), duration: 3000 })
    dialog.clear()
    return <></>
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("tui.modalities.title", { model: model.name ?? current.modelID })}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {t("tui.dialog.close_hint")}
        </text>
      </box>
      <box flexDirection="column" paddingTop={1}>
        <For each={[...MODALITIES]}>
          {(modality, index) => (
            <box
              flexDirection="row"
              gap={2}
              paddingLeft={1}
              backgroundColor={store.active === index() ? theme.backgroundElement : undefined}
              onMouseUp={() => {
                setStore("active", index())
                setStore(modality, !store[modality])
              }}
            >
              <text fg={store.active === index() ? theme.primary : theme.textMuted}>
                {store[modality] ? "[x]" : "[ ]"}
              </text>
              <text fg={store.active === index() ? theme.primary : theme.text}>{modality}</text>
            </box>
          )}
        </For>
      </box>
      <text fg={theme.textMuted} paddingTop={1}>
        <span style={{ fg: theme.text }}>space</span> {t("tui.modalities.hint.toggle")},{" "}
        <span style={{ fg: theme.text }}>return</span> {t("tui.modalities.hint.save")}
      </text>
    </box>
  )
}

DialogModalities.show = (dialog: DialogContext) => {
  dialog.replace(() => <DialogModalities />)
}
