import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useKV } from "../context/kv"
import { useToast } from "../ui/toast"
import { useLanguage } from "../context/language"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Global } from "@/global"
import { createResource, onCleanup } from "solid-js"
import path from "path"
import os from "os"
import fs from "fs/promises"

const BG_DIR = path.join(Global.Path.config, "backgrounds")
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"])
const NONE_VALUE = "__mimocode_image_none__"
const IMPORT_VALUE = "__mimocode_image_import__"

async function listBackgrounds() {
  await fs.mkdir(BG_DIR, { recursive: true }).catch(() => {})
  const items = await fs.readdir(BG_DIR).catch(() => [] as string[])
  return items
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
}

function expandHome(p: string) {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

export function DialogImageList() {
  const dialog = useDialog()
  const kv = useKV()
  const toast = useToast()
  const { t } = useLanguage()
  const [files] = createResource(listBackgrounds)
  const initial = kv.get("background_image")
  let confirmed = false

  onCleanup(() => {
    if (!confirmed) kv.set("background_image", initial)
  })

  const importImage = async () => {
    const raw = await DialogPrompt.show(dialog, t("tui.dialog.image.import.title"), {
      placeholder: t("tui.dialog.image.import.placeholder"),
    })
    if (raw === null) return
    const src = expandHome(raw.trim().replace(/^['"]|['"]$/g, ""))
    if (!src) return
    if (!IMAGE_EXT.has(path.extname(src).toLowerCase())) {
      toast.show({ message: t("tui.dialog.image.import.invalid"), variant: "error" })
      return
    }
    if (!(await Bun.file(src).exists())) {
      toast.show({ message: t("tui.dialog.image.import.not_found"), variant: "error" })
      return
    }
    await fs.mkdir(BG_DIR, { recursive: true })
    const base = path.basename(src)
    const dst = path.join(BG_DIR, base)
    await fs.copyFile(src, dst).catch((err) => {
      toast.show({ message: String(err), variant: "error" })
      throw err
    })
    kv.set("background_image", base)
    toast.show({ message: t("tui.dialog.image.import.success"), variant: "info" })
  }

  const options = (): DialogSelectOption<string>[] => {
    const list: DialogSelectOption<string>[] = [
      {
        title: t("tui.dialog.image.import.option"),
        value: IMPORT_VALUE,
        onSelect: () => {
          void importImage()
        },
      },
    ]
    for (const f of files() ?? []) list.push({ title: f, value: f })
    list.push({ title: t("tui.dialog.image.none"), value: NONE_VALUE })
    return list
  }

  return (
    <DialogSelect
      title={t("tui.dialog.image.title")}
      options={options()}
      current={initial}
      onMove={(opt) => {
        if (opt.value === IMPORT_VALUE) return
        if (opt.value === NONE_VALUE) {
          kv.set("background_image", undefined)
          return
        }
        kv.set("background_image", opt.value)
      }}
      onSelect={(opt) => {
        if (opt.value === IMPORT_VALUE) return
        if (opt.value === NONE_VALUE) {
          kv.set("background_image", undefined)
        } else {
          kv.set("background_image", opt.value)
        }
        confirmed = true
        dialog.clear()
      }}
    />
  )
}
