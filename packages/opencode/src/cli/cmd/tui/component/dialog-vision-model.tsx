import { createMemo, createSignal } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"

export function DialogVisionModel() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [query, setQuery] = createSignal("")

  const currentVisionModel = createMemo(() => sync.data.config.vision_model)

  const options = createMemo(() => {
    const needle = query().trim()

    const visionOptions: Array<{
      value: string
      title: string
      description: string | undefined
      category: string
      onSelect: () => void
    }> = []

    for (const provider of sync.data.provider) {
      for (const [modelID, model] of Object.entries(provider.models)) {
        if (!model.capabilities?.input?.image) continue
        const ref = `${provider.id}/${modelID}`
        visionOptions.push({
          value: ref,
          title: model.name ?? modelID,
          description: currentVisionModel() === ref ? "(当前)" : undefined,
          category: provider.name,
          onSelect: () => onSelect(ref),
        })
      }
    }

    if (needle) {
      return visionOptions.filter(
        (x) =>
          x.title.toLowerCase().includes(needle.toLowerCase()) ||
          x.value.toLowerCase().includes(needle.toLowerCase()),
      )
    }

    return visionOptions
  })

  async function onSelect(value: string) {
    const patch = { vision_model: value }
    const res = await sdk.client.global.config.update({ config: patch as any })
    if (res.error) {
      toast.show({ variant: "error", message: JSON.stringify(res.error) })
      return
    }
    toast.show({ variant: "success", message: `视觉模型已设置为 ${value}` })
    dialog.clear()
  }

  async function onClear() {
    const patch = { vision_model: null }
    const res = await sdk.client.global.config.update({ config: patch as any })
    if (res.error) {
      toast.show({ variant: "error", message: JSON.stringify(res.error) })
      return
    }
    toast.show({ variant: "success", message: "视觉模型已清除" })
    dialog.clear()
  }

  return (
    <DialogSelect<string>
      options={[
        ...options(),
        {
          value: "__clear__",
          title: "关闭视觉模型",
          description: currentVisionModel() ? "移除当前设置" : undefined,
          category: undefined as unknown as string,
          onSelect: onClear,
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title="选择视觉模型"
    />
  )
}
